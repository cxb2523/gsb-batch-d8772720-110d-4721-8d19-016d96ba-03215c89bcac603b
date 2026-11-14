import * as chai from 'chai';
chai.should();

import nock from 'nock';
import fs from 'fs';
import path from 'path';
import scrape from 'website-scraper';

const testDirname = './test/functional/redirect/.tmp-dedup';

describe('Functional redirect deduplication', function () {

	beforeEach(function () {
		nock.cleanAll();
		nock.disableNetConnect();
	});

	afterEach(function () {
		nock.cleanAll();
		nock.enableNetConnect();
		fs.rmSync(testDirname, { recursive: true, force: true });
	});

	it('should save an image once when two page addresses resolve to the same final url and rewrite both parent references', async () => {
		// entry page references the same picture through two different urls
		nock('http://example.com/').get('/').reply(200,
			'<html><body>' +
			'<img src="/img/logo.png">' +
			'<img src="/assets/picture-logo.png">' +
			'</body></html>',
			{ 'content-type': 'text/html' });

		// the second address is redirected to the first one
		nock('http://example.com/').get('/assets/picture-logo.png')
			.reply(302, '', { 'Location': 'http://example.com/img/logo.png' });

		// a single interceptor: a second request to the final url would make nock throw
		nock('http://example.com/').get('/img/logo.png')
			.reply(200, Buffer.from([0x89, 0x50, 0x4e, 0x47]), { 'content-type': 'image/png' });

		await scrape({
			urls: [ 'http://example.com/' ],
			directory: testDirname,
			subdirectories: null,
			recursive: false,
			sources: [ { selector: 'img', attr: 'src' } ]
		});

		// only one image file is saved, no _1 duplicate
		const files = fs.readdirSync(testDirname);
		const images = files.filter((file) => getExtension(file) === '.png');
		images.should.have.length(1);
		images[0].should.be.eql('logo.png');
		fs.existsSync(path.join(testDirname, 'logo.png')).should.be.eql(true);
		fs.existsSync(path.join(testDirname, 'picture-logo.png')).should.be.eql(false);
		fs.existsSync(path.join(testDirname, 'logo_1.png')).should.be.eql(false);

		// every nock interceptor (including the single final-url one) was consumed exactly once
		nock.isDone().should.be.eql(true);

		// both parent references point at the saved file
		const savedPage = fs.readFileSync(path.join(testDirname, 'index.html')).toString();
		const matches = savedPage.match(/src="logo\.png"/g) || [];
		matches.should.have.length(2);
		savedPage.should.not.contain('picture-logo.png');
	});

	it('should not rewrite the parent reference when the redirect target is rejected by urlFilter', async () => {
		nock('http://example.com/').get('/').reply(200,
			'<html><body><img src="/img/moved-logo.png"></body></html>',
			{ 'content-type': 'text/html' });

		// original url passes the filter, redirect target does not
		nock('http://example.com/').get('/img/moved-logo.png')
			.reply(302, '', { 'Location': 'http://internal.example/img/logo.png' });
		const internal = nock('http://internal.example/').get('/img/logo.png')
			.reply(200, Buffer.from([0x89, 0x50, 0x4e, 0x47]), { 'content-type': 'image/png' });

		await scrape({
			urls: [ 'http://example.com/' ],
			directory: testDirname,
			subdirectories: null,
			recursive: false,
			sources: [ { selector: 'img', attr: 'src' } ],
			urlFilter: (url) => new URL(url).hostname === 'example.com'
		});

		// the redirect is followed by the http client but the response is dropped
		internal.isDone().should.be.eql(true);

		// no image is saved and the original parent reference is left untouched
		fs.readdirSync(testDirname).filter((file) => getExtension(file) === '.png')
			.should.have.length(0);
		fs.readFileSync(path.join(testDirname, 'index.html')).toString()
			.should.contain('<img src="/img/moved-logo.png">');
	});

	it('should save an image once when the same final url is referenced from different depths', async () => {
		// entry page (depth 0) links to a nested page and embeds the image directly
		nock('http://example.com/').get('/').reply(200,
			'<html><body>' +
			'<a href="/pages/about.html">about</a>' +
			'<img src="/img/logo.png">' +
			'</body></html>',
			{ 'content-type': 'text/html' });

		nock('http://example.com/').get('/pages/about.html').reply(200,
			'<html><body><img src="../img/logo.png"></body></html>',
			{ 'content-type': 'text/html' });

		// one interceptor for the final image url
		nock('http://example.com/').get('/img/logo.png')
			.reply(200, Buffer.from([0x89, 0x50, 0x4e, 0x47]), { 'content-type': 'image/png' });

		await scrape({
			urls: [ 'http://example.com/' ],
			directory: testDirname,
			subdirectories: null,
			recursive: true,
			maxDepth: 3,
			sources: [
				{ selector: 'img', attr: 'src' },
				{ selector: 'a', attr: 'href' }
			]
		});

		nock.isDone().should.be.eql(true);

		// a single image file, both pages get a working relative reference to it
		const images = fs.readdirSync(testDirname).filter((file) => getExtension(file) === '.png');
		images.should.have.length(1);
		images[0].should.be.eql('logo.png');

		fs.readFileSync(path.join(testDirname, 'index.html')).toString()
			.should.contain('src="logo.png"');
		fs.readFileSync(path.join(testDirname, 'about.html')).toString()
			.should.contain('src="logo.png"');
	});
});

function getExtension (filename) {
	return path.extname(filename).toLowerCase();
}
