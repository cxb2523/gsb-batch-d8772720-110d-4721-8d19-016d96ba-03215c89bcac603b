const path = require('path');
const fs = require('fs');
const nodeUrl = require('url');
const crypto = require('crypto');
const Bluebird = require('bluebird');
const axios = require('axios');
const parseContentDisposition = require('content-disposition').parse;
const mime = require('mime');
const uuid = require('uuid');
const padLeft = require('pad-left');
const get = require('lodash.get');
const makeDir = require('make-dir');
const debug = require('debug')('jason:transform:download-file');

const MB = 1024 * 1024;
const REGEX_UUID = /{uuid}/g;
const REGEX_HASH = /{hash}/g;
const REGEX_INDEX = /{index}/g;
const REGEX_NAME = /{name}/g;
const REGEX_SELECTOR = /{selector}/g;

/**
 * A processor that downloads files.
 */
class FileDownloader {
  /**
   * @param {Object} config
   * @param {string} [config.baseURL]
   * @param {string} [config.folder='.'] The output folder
   * @param {string} [config.parseSelector] Selector to retrieve the download urls in the
   * array of parsed data
   * @param {string} [config.nameSelector] Selector to retrieve the file name in the
   * array of parsed data
   * @param {string} [config.namePattern='{name}'] The pattern used to create the filenames:
   *  {name} -> the base name of the downloaded file
   *  {index} -> the file index
   *  {uuid} -> a unique id
   *  {hash} -> the sha256 hash of the downloaded file
   *  {selector} -> the value extracted using the nameSelector option
   * @param {Object} [config.maxSizeInMb=1]
   * @param {Object} [config.concurrency=1]
   */
  constructor({ config = {} } = {}) {
    this._config = {
      folder: '',
      namePattern: '{name}',
      maxSizeInMb: 1,
      concurrency: 1,
      ...config,
    };
    this._config.concurrency = Number(this._config.concurrency); // just in case

    this._httpConfig = { baseURL: this._config.baseURL, responseType: 'stream' };
    this._httpClient = axios.create(this._httpConfig);

    this._outputFolder = path.join(process.cwd(), this._config.folder);
    this._maxBytesSize = this._config.maxSizeInMb * MB;
    // Filenames already taken during the current run(), to make sure that
    // every successful download gets its own path on disk
    this._reservedFilenames = new Set();

    debug('FileDownloader instance created.');
    debug('HTTP config', this._httpConfig);
    debug('config', this._config);
  }

  /**
   * @param {Object} results The results from the previous transformer if any, or the
   * parse results by default
   * @param {Object} parseResults The original parse results
   * @return {Promise}
   */
  async run({ results }) {
    if (!results) {
      debug('No results to download!');
      return [];
    }

    const rootKey = Object.keys(results)[0];
    const downloads = Array.isArray(results) ? results : (results[rootKey] || []);
    const { parseSelector, nameSelector, concurrency } = this._config;

    const downloadsWithUrlAndName = parseSelector
      ? downloads.map(d => ({
        url: get(d, parseSelector),
        parsedName: get(d, nameSelector, ''),
      }))
      : downloads.map(url => ({
        url,
        parsedName: '',
      }));

    const downloadsWithUrl = downloadsWithUrlAndName.filter(({ url }) => Boolean(url));

    const total = downloadsWithUrl.length;

    debug('Found %d file(s) to download at max concurrency=%d...', total, concurrency);
    // debug(downloadsWithUrl);

    debug('Creating ouput folder "%s"...', this._outputFolder);
    await makeDir(this._outputFolder);

    // Reset the names taken by a previous run(): each run deduplicates on its own
    this._reservedFilenames.clear();

    // Reserve a unique base name for every download in input order, before any
    // download starts: the dedup suffix (-1, -2, ...) is therefore stable and
    // independent of the (potentially concurrent) completion order
    const downloadsWithReservedName = downloadsWithUrl.map((d, index) => ({
      ...d,
      reservedBaseName: this._reserveBaseName({ ...d, index, total }),
    }));

    const filePaths = await Bluebird.map(
      downloadsWithReservedName,
      ({ url, reservedBaseName }) => this._download({
        url,
        reservedBaseName,
      }),
      { concurrency },
    );

    return { results, filePaths };
  }

  /**
   * @param {string} url
   * @param {string} reservedBaseName The unique (within the run) base name
   * computed from the namePattern before the download started
   * @return {Promise}
   */
  async _download({
    url,
    reservedBaseName,
  }) {
    debug('Dowloading "%s"...', url);

    try {
      const response = await this._httpClient.get(url);
      const { headers } = response;

      this._checkContentLength({ url, headers });

      const ext = this._getFileExtensionFromHeaders({ headers });
      const filename = `${reservedBaseName}${ext}`;

      return this._saveFile({ filename, response });
    } catch (error) {
      debug(error.message);
      return error; // reflect to avoid Bluebird.map() to fail
    }
  }

  /**
   * @param {string} url
   * @param {Object} headers
   */
  _checkContentLength({ url, headers }) {
    const contentLength = Number(headers['content-length']);

    if (contentLength > this._maxBytesSize) {
      const error = new Error(`"${url}" too large (${contentLength} bytes received, max=${this._maxBytesSize} bytes)!`);
      throw error;
    }
  }

  /**
   * Builds the base name (without the response-derived extension) from the
   * configured namePattern and reserves a unique value for it within the
   * current run(): if the resulting name is already taken by another download
   * of the same run, a stable dedup suffix (-1, -2, ...) is inserted before
   * the pattern extension.
   * @param {string} url
   * @param {string} [parsedName]
   * @param {number} index
   * @param {number} total
   * @return {string}
   */
  _reserveBaseName({
    url,
    parsedName,
    index,
    total,
  }) {
    const parsedUrl = nodeUrl.parse(url);
    const { name: baseNameFromUrl } = path.parse(parsedUrl.pathname);

    const baseName = [
      FileDownloader.replacers.name.bind(null, baseNameFromUrl),
      FileDownloader.replacers.index.bind(null, index, total),
      FileDownloader.replacers.uuid,
      FileDownloader.replacers.hash,
      FileDownloader.replacers.selector.bind(null, parsedName),
    ].reduce(
      (currentName, replacer) => replacer(currentName),
      this._config.namePattern,
    );

    let reservedName = baseName;

    if (this._reservedFilenames.has(reservedName)) {
      const parsedBaseName = path.parse(baseName);
      const hasName = Boolean(parsedBaseName.name);
      const dedupBaseName = hasName ? parsedBaseName.name : baseName;
      const patternExtension = hasName ? parsedBaseName.ext : '';
      let dedupIndex = 1;
      do {
        reservedName = `${dedupBaseName}-${dedupIndex}${patternExtension}`;
        dedupIndex += 1;
      } while (this._reservedFilenames.has(reservedName));
    }

    this._reservedFilenames.add(reservedName);

    return reservedName;
  }

  /**
   * @param {Object} headers
   * @return {string}
   */
  // eslint-disable-next-line class-methods-use-this
  _getFileExtensionFromHeaders({ headers }) {
    const contentDisposition = headers['content-disposition'];
    if (contentDisposition) {
      const parsedDisposition = parseContentDisposition(contentDisposition);

      if (parsedDisposition.parameters && parsedDisposition.parameters.filename) {
        const extension = path.parse(parsedDisposition.parameters.filename).ext;
        return extension.toLowerCase();
      }
    }

    const contentType = headers['content-type'];
    // mime.getExtension() returns false/undefined when the content-type is
    // unknown: keep a nameless extension instead of producing ".false"
    const mappedExtension = contentType ? mime.getExtension(contentType.split(';')[0].trim()) : false;

    return mappedExtension ? `.${mappedExtension}` : '';
  }

  /**
   * @param {string} filename
   * @param {HttpResponse} response
   * @return {Promise}
   */
  async _saveFile({ filename, response }) {
    return new Promise((resolve, reject) => {
      const filePath = path.join(this._outputFolder, filename);
      debug('Saving file "%s"...', filePath);

      const writeStream = fs.createWriteStream(filePath);

      response.data
        .on('error', (error) => {
          debug(error.message);
          reject(error);
        })
        .pipe(writeStream);

      writeStream
        .on('error', (error) => {
          debug(error.message);
          reject(error);
        })
        .on('finish', () => {
          debug('File "%s" saved!', filePath);
          resolve(filePath);
        });
    });
  }
}

FileDownloader.replacers = {
  name: (name, namePattern) => namePattern.replace(REGEX_NAME, name),
  index: (index, total, namePattern) => {
    const padCount = Math.ceil(Math.log10(total));
    return namePattern.replace(REGEX_INDEX, padLeft(index, padCount, '0'));
  },
  uuid: namePattern => namePattern.replace(REGEX_UUID, uuid()),
  hash: (namePattern) => {
    const hash = crypto.createHash('sha256').update(namePattern).digest('hex');
    return namePattern.replace(REGEX_HASH, hash);
  },
  selector: (parsedName, namePattern) => namePattern.replace(REGEX_SELECTOR, parsedName),
};

module.exports = FileDownloader;
