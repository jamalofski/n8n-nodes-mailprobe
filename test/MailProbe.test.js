'use strict';

// Runs against the compiled node: `npm test` builds first.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { MailProbe } = require('../dist/nodes/MailProbe/MailProbe.node.js');
const { version } = require('../package.json');

const NODE = {
	id: 'test-node',
	name: 'MailProbe',
	type: 'n8n-nodes-mailprobe.mailProbe',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

function ok(body) {
	return { statusCode: 200, headers: {}, body };
}

function fail(statusCode, code, error, headers = {}) {
	return { statusCode, headers, body: { error, code } };
}

function verdicts(emails) {
	return emails.map((email) => ({ email, status: 'valid', result: 'deliverable', score: 95 }));
}

// Minimal IExecuteFunctions: parameters, input items and the authenticated request helper.
function run({ emails, resource = 'email', operation = 'verify', continueOnFail = false, respond }) {
	const items = emails.map((email) => ({ json: { email } }));
	const calls = [];
	const context = {
		getInputData: () => items,
		getNodeParameter: (name, itemIndex, fallback) => {
			if (name === 'resource') return resource;
			if (name === 'operation') return operation;
			if (name === 'email') return items[itemIndex].json.email;
			return fallback;
		},
		continueOnFail: () => continueOnFail,
		getNode: () => NODE,
		helpers: {
			httpRequestWithAuthentication: async (credentialType, options) => {
				calls.push({ credentialType, options });
				return respond(options, calls.length);
			},
		},
	};
	const promise = new MailProbe().execute.call(context).then(([output]) => output);
	return { promise, calls };
}

function sentEmails(call) {
	return call.options.body.emails;
}

test('sends 20 addresses per request and keeps the input order', async () => {
	const emails = Array.from({ length: 45 }, (_, i) => `user${i}@example.com`);
	const { promise, calls } = run({ emails, respond: (options) => ok(verdicts(options.body.emails)) });
	const output = await promise;

	assert.deepEqual(
		calls.map((call) => sentEmails(call).length),
		[20, 20, 5],
	);
	assert.equal(output.length, 45);
	output.forEach((item, i) => {
		assert.equal(item.json.email, emails[i]);
		assert.deepEqual(item.pairedItem, { item: i });
	});
});

test('calls the documented endpoint with the node user agent', async () => {
	const { promise, calls } = run({
		emails: ['a@example.com'],
		respond: (options) => ok(verdicts(options.body.emails)),
	});
	await promise;

	const { credentialType, options } = calls[0];
	assert.equal(credentialType, 'mailProbeApi');
	assert.equal(options.method, 'POST');
	assert.equal(options.url, 'https://mailprobe.dev/api/v1/verify');
	assert.deepEqual(options.body, { emails: ['a@example.com'] });
	assert.equal(options.headers['User-Agent'], `n8n-nodes-mailprobe/${version}`);
	assert.equal(options.json, true);
	assert.equal(options.returnFullResponse, true);
	assert.equal(options.ignoreHttpStatusErrors, true);
	assert.equal(options.timeout, 130000);
});

test('waits for Retry-After on a 429, then retries', async () => {
	const started = Date.now();
	const { promise, calls } = run({
		emails: ['a@example.com'],
		respond: (options, n) =>
			n === 1
				? fail(429, 'RATE_LIMITED', 'Rate limit exceeded.', { 'retry-after': '1' })
				: ok(verdicts(options.body.emails)),
	});
	const output = await promise;

	assert.equal(calls.length, 2);
	assert.ok(Date.now() - started >= 1000, 'the retry waited for Retry-After');
	assert.equal(output[0].json.status, 'valid');
});

test('gives up after five rate-limited retries', async () => {
	const { promise, calls } = run({
		emails: ['a@example.com'],
		respond: () => fail(429, 'RATE_LIMITED', 'Rate limit exceeded.', { 'retry-after': '0' }),
	});

	await assert.rejects(promise, { message: 'MailProbe rate limit reached' });
	assert.equal(calls.length, 6);
});

test('isolates an address on a paid-only domain and skips that domain afterwards', async () => {
	const emails = Array.from({ length: 25 }, (_, i) => `user${i}@example.com`);
	emails[1] = 'blocked1@comcast.net';
	emails[21] = 'blocked2@comcast.net';
	const refused = (list) => list.some((email) => email.endsWith('@comcast.net'));
	const { promise, calls } = run({
		emails,
		continueOnFail: true,
		respond: (options) =>
			refused(options.body.emails)
				? fail(
						402,
						'PAID_ONLY_DOMAIN',
						'Addresses at comcast.net can only be verified with purchased credits: free credits and the free verifier do not cover this domain.',
					)
				: ok(verdicts(options.body.emails)),
	});
	const output = await promise;

	// First batch refused, then split address by address; the second batch goes out without
	// the comcast.net address.
	assert.equal(calls.length, 1 + 20 + 1);
	assert.deepEqual(sentEmails(calls[21]), emails.slice(20).filter((_, i) => i !== 1));
	assert.equal(output.length, 25);
	assert.match(output[1].json.error, /purchased credits/);
	assert.match(output[21].json.error, /purchased credits/);
	assert.equal(output[1].json.email, 'blocked1@comcast.net');
	assert.equal(output[0].json.status, 'valid');
	assert.equal(output[24].json.status, 'valid');
});

test('stops sending once the credits run out', async () => {
	const emails = Array.from({ length: 25 }, (_, i) => `user${i}@example.com`);
	let balance = 3;
	const { promise, calls } = run({
		emails,
		continueOnFail: true,
		respond: (options) => {
			const requested = options.body.emails.length;
			if (requested > balance) {
				return fail(402, 'NO_CREDITS', `Insufficient credits. Need ${requested}, have ${balance}`);
			}
			balance -= requested;
			return ok(verdicts(options.body.emails));
		},
	});
	const output = await promise;

	// The batch of 20 is refused, three single addresses pass, the fourth is refused: no request
	// after that.
	assert.equal(calls.length, 1 + 4);
	assert.equal(output.filter((item) => item.json.status === 'valid').length, 3);
	assert.equal(output.filter((item) => /Insufficient credits/.test(item.json.error)).length, 22);
});

test('fails the node with a clear message when the API key is rejected', async () => {
	const { promise, calls } = run({
		emails: ['a@example.com', 'b@example.com'],
		respond: () => fail(401, 'UNAUTHORIZED', 'Invalid or missing API key'),
	});

	await assert.rejects(promise, (error) => {
		assert.equal(error.message, 'Invalid or missing MailProbe API key');
		assert.equal(error.httpCode, '401');
		return true;
	});
	assert.equal(calls.length, 1);
});

test('reports an empty email as an item error without calling the API', async () => {
	const { promise, calls } = run({
		emails: ['  ', 'a@example.com'],
		continueOnFail: true,
		respond: (options) => ok(verdicts(options.body.emails)),
	});
	const output = await promise;

	assert.equal(calls.length, 1);
	assert.deepEqual(sentEmails(calls[0]), ['a@example.com']);
	assert.equal(output[0].json.error, 'The Email parameter is empty');
	assert.equal(output[1].json.status, 'valid');
});

test('does not retry a server error, since probed addresses are billed', async () => {
	const { promise, calls } = run({
		emails: ['a@example.com', 'b@example.com'],
		continueOnFail: true,
		respond: () => fail(500, 'INTERNAL_ERROR', 'Verification failed'),
	});
	const output = await promise;

	assert.equal(calls.length, 1);
	assert.equal(output.length, 2);
	for (const item of output) {
		assert.equal(item.json.error, 'MailProbe could not complete the verification');
	}
});

test('stops at the first network failure', async () => {
	const emails = Array.from({ length: 25 }, (_, i) => `user${i}@example.com`);
	const { promise, calls } = run({
		emails,
		continueOnFail: true,
		respond: () => {
			throw Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
		},
	});
	const output = await promise;

	assert.equal(calls.length, 1);
	assert.equal(output.length, 25);
	assert.ok(output.every((item) => typeof item.json.error === 'string'));
});

test('returns the credit balance for each input item', async () => {
	const { promise, calls } = run({
		emails: ['', ''],
		resource: 'account',
		operation: 'getCredits',
		respond: () => ok({ credits: 847 }),
	});
	const output = await promise;

	assert.equal(calls.length, 2);
	assert.equal(calls[0].options.method, 'GET');
	assert.equal(calls[0].options.url, 'https://mailprobe.dev/api/v1/credits');
	assert.deepEqual(
		output.map((item) => item.json),
		[{ credits: 847 }, { credits: 847 }],
	);
});
