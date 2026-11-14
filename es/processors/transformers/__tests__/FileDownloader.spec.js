const fs = require('fs');
const os = require('os');
const path = require('path');
const stream = require('stream');
const FileDownloader = require('../FileDownloader');

function createStream(body) {
  const data = Buffer.from(body);
  return new stream.Readable({
    read() {
      if (!this._pushed) {
        this._pushed = true;
        this.push(data);
        this.push(null);
      }
    },
  });
}

function createResponse({ body = '', headers = {} }) {
  return Promise.resolve({
    headers,
    data: createStream(body),
  });
}

function stubHttpClient(downloader, responsesByUrl) {
  // eslint-disable-next-line no-param-reassign
  downloader._httpClient = {
    get: jest.fn(url => createResponse(responsesByUrl[url])),
  };
}

describe('FileDownloader', () => {
  const originalCwd = process.cwd();
  let tmpRoot;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jason-fd-'));
  });

  afterAll(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    process.chdir(tmpRoot);
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  it('should be a class with the following API: run({ results })', () => {
    expect(FileDownloader).toBeInstanceOf(Function);
    expect(FileDownloader.prototype.run).toBeInstanceOf(Function);
  });

  describe('#run({ results })', () => {
    it('should deduplicate filenames within the same run and keep filePaths in download order', async () => {
      const folder = 'dedup';
      const downloader = new FileDownloader({ config: { folder, concurrency: 2 } });
      const firstUrl = 'http://example.com/a/photo.png';
      const secondUrl = 'http://example.com/b/photo.png';

      stubHttpClient(downloader, {
        [firstUrl]: {
          body: 'first body',
          headers: { 'content-type': 'image/png' },
        },
        [secondUrl]: {
          body: 'second body',
          headers: { 'content-type': 'image/png' },
        },
      });

      const { filePaths } = await downloader.run({ results: [firstUrl, secondUrl] });

      expect(filePaths).toHaveLength(2);
      expect(path.basename(filePaths[0])).toBe('photo.png');
      expect(path.basename(filePaths[1])).toBe('photo-1.png');

      const files = fs.readdirSync(path.join(tmpRoot, folder)).sort();
      expect(files).toEqual(['photo-1.png', 'photo.png']);
      expect(fs.readFileSync(filePaths[0], 'utf8')).toBe('first body');
      expect(fs.readFileSync(filePaths[1], 'utf8')).toBe('second body');
    });

    it('should keep files without an extension when the content-type is unknown', async () => {
      const folder = 'unknown-type';
      const downloader = new FileDownloader({ config: { folder } });
      const bogusTypeUrl = 'http://example.com/data/raw';
      const noHeaderUrl = 'http://example.com/data/no-header';
      const duplicateUrlA = 'http://example.com/a/thing';
      const duplicateUrlB = 'http://example.com/b/thing';

      stubHttpClient(downloader, {
        [bogusTypeUrl]: {
          body: 'raw body',
          headers: { 'content-type': 'application/x-totally-unknown' },
        },
        [noHeaderUrl]: {
          body: 'no header body',
          headers: {},
        },
        [duplicateUrlA]: {
          body: 'thing one',
          headers: { 'content-type': 'application/x-totally-unknown' },
        },
        [duplicateUrlB]: {
          body: 'thing two',
          headers: { 'content-type': 'application/x-totally-unknown' },
        },
      });

      const { filePaths } = await downloader.run({
        results: [bogusTypeUrl, noHeaderUrl, duplicateUrlA, duplicateUrlB],
      });

      expect(path.basename(filePaths[0])).toBe('raw');
      expect(path.basename(filePaths[1])).toBe('no-header');
      expect(path.basename(filePaths[2])).toBe('thing');
      expect(path.basename(filePaths[3])).toBe('thing-1');

      const files = fs.readdirSync(path.join(tmpRoot, folder)).sort();
      expect(files).toEqual(['no-header', 'raw', 'thing', 'thing-1']);
      expect(files.every(file => !file.includes('.false') && !file.includes('.undefined'))).toBe(true);
    });

    it('should return an error for oversized files while still saving the other files and completing the run', async () => {
      const folder = 'mixed';
      const maxBytes = 1 * 1024 * 1024;
      const downloader = new FileDownloader({ config: { folder, maxSizeInMb: 1 } });
      const smallUrlA = 'http://example.com/a/small.png';
      const hugeUrl = 'http://example.com/b/huge.png';
      const smallUrlB = 'http://example.com/c/small.png';

      stubHttpClient(downloader, {
        [smallUrlA]: {
          body: 'small a',
          headers: { 'content-type': 'image/png', 'content-length': String(10) },
        },
        [hugeUrl]: {
          body: 'should never be written',
          headers: { 'content-type': 'image/png', 'content-length': String(maxBytes + 1) },
        },
        [smallUrlB]: {
          body: 'small b',
          headers: { 'content-type': 'image/png', 'content-length': String(10) },
        },
      });

      const { filePaths } = await downloader.run({
        results: [smallUrlA, hugeUrl, smallUrlB],
      });

      expect(filePaths).toHaveLength(3);
      expect(filePaths[0]).toBe(path.join(tmpRoot, folder, 'small.png'));
      expect(filePaths[1]).toBeInstanceOf(Error);
      expect(filePaths[1].message).toContain('too large');
      expect(filePaths[1].message).toContain(hugeUrl);
      expect(filePaths[2]).toBe(path.join(tmpRoot, folder, 'small-1.png'));

      const files = fs.readdirSync(path.join(tmpRoot, folder)).sort();
      expect(files).toEqual(['small-1.png', 'small.png']);
      expect(fs.readFileSync(filePaths[0], 'utf8')).toBe('small a');
      expect(fs.readFileSync(filePaths[2], 'utf8')).toBe('small b');
    });

    it('should still use the content-disposition filename extension when available', async () => {
      const folder = 'disposition';
      const downloader = new FileDownloader({ config: { folder } });
      const url = 'http://example.com/download?id=1';

      stubHttpClient(downloader, {
        [url]: {
          body: 'pdf body',
          headers: {
            'content-type': 'text/html',
            'content-disposition': 'attachment; filename="report.pdf"',
          },
        },
      });

      const { filePaths } = await downloader.run({ results: [url] });

      expect(path.basename(filePaths[0])).toBe('download.pdf');
      expect(fs.readFileSync(filePaths[0], 'utf8')).toBe('pdf body');
    });

    it('should reset the deduplicated names between two runs', async () => {
      const folder = 'two-runs';
      const downloader = new FileDownloader({ config: { folder } });
      const firstUrl = 'http://example.com/a/photo.png';
      const secondUrl = 'http://example.com/b/photo.png';

      stubHttpClient(downloader, {
        [firstUrl]: { body: 'run 1', headers: { 'content-type': 'image/png' } },
        [secondUrl]: { body: 'run 1 dup', headers: { 'content-type': 'image/png' } },
      });

      const firstRun = await downloader.run({ results: [firstUrl, secondUrl] });
      expect(path.basename(firstRun.filePaths[0])).toBe('photo.png');
      expect(path.basename(firstRun.filePaths[1])).toBe('photo-1.png');

      const secondRun = await downloader.run({ results: [firstUrl, secondUrl] });
      expect(path.basename(secondRun.filePaths[0])).toBe('photo.png');
      expect(path.basename(secondRun.filePaths[1])).toBe('photo-1.png');
    });
  });
});
