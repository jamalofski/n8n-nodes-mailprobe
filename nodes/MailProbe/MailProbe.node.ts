import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError, sleep } from 'n8n-workflow';

import { version } from '../../package.json';

const BASE_URL = 'https://mailprobe.dev';

// POST /api/v1/verify accepts up to 20 addresses per request.
const MAX_EMAILS_PER_REQUEST = 20;

// The API allows 60 requests per minute per key and answers 429 with a Retry-After header.
const MAX_RATE_LIMIT_RETRIES = 5;
const MAX_RETRY_AFTER_SECONDS = 60;

// The server's proxy gives a request 120 seconds.
const REQUEST_TIMEOUT_MS = 130_000;

const USER_AGENT = `n8n-nodes-mailprobe/${version}`;

type NodeError = NodeApiError | NodeOperationError;

interface FullResponse {
	body: unknown;
	headers: Record<string, string | string[] | undefined>;
	statusCode: number;
}

interface PendingEmail {
	itemIndex: number;
	email: string;
}

function isObject(value: unknown): value is IDataObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorCode(response: FullResponse): string | undefined {
	return isObject(response.body) && typeof response.body.code === 'string'
		? response.body.code
		: undefined;
}

function domainOf(email: string): string {
	return email.slice(email.lastIndexOf('@') + 1).toLowerCase();
}

function retryAfterMs(headers: FullResponse['headers']): number {
	const raw = headers['retry-after'];
	const seconds = Number(Array.isArray(raw) ? raw[0] : raw);
	const wait =
		Number.isFinite(seconds) && seconds >= 0
			? Math.min(seconds, MAX_RETRY_AFTER_SECONDS)
			: MAX_RETRY_AFTER_SECONDS;
	// A little past the reset, so the retry lands in the new window.
	return wait * 1000 + 250;
}

function describeError(
	statusCode: number,
	code: string | undefined,
	apiMessage: string | undefined,
): { message: string; description?: string } {
	switch (code) {
		case 'UNAUTHORIZED':
			return {
				message: 'Invalid or missing MailProbe API key',
				description:
					'Check the API key in the MailProbe credential. You can create a new one under Developer in your MailProbe account.',
			};
		case 'NO_CREDITS':
			return {
				message: apiMessage ?? 'Not enough MailProbe credits',
				description: 'Buy credits at https://mailprobe.dev/pricing/ and run the workflow again.',
			};
		case 'PAID_ONLY_DOMAIN':
			return {
				message: apiMessage ?? 'This domain can only be verified with purchased credits',
				description: 'Buy credits at https://mailprobe.dev/pricing/ to verify this domain.',
			};
		case 'RATE_LIMITED':
			return {
				message: 'MailProbe rate limit reached',
				description:
					'The API allows 60 requests per minute per API key. The node waited and retried several times: another workflow may be using the same key.',
			};
	}
	if (statusCode >= 500) {
		return {
			message: 'MailProbe could not complete the verification',
			description: `${apiMessage ? `${apiMessage}. ` : ''}Credits are refunded when a verification fails on MailProbe's side.`,
		};
	}
	return { message: apiMessage ?? `MailProbe returned HTTP ${statusCode}` };
}

async function mailProbeRequest(
	this: IExecuteFunctions,
	method: IHttpRequestMethods,
	path: string,
	body?: IDataObject,
): Promise<FullResponse> {
	const options: IHttpRequestOptions = {
		method,
		url: `${BASE_URL}${path}`,
		headers: { 'User-Agent': USER_AGENT },
		json: true,
		timeout: REQUEST_TIMEOUT_MS,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	};
	if (body) options.body = body;

	for (let attempt = 0; ; attempt++) {
		const response = (await this.helpers.httpRequestWithAuthentication.call(
			this,
			'mailProbeApi',
			options,
		)) as FullResponse;
		if (response.statusCode !== 429 || attempt >= MAX_RATE_LIMIT_RETRIES) return response;
		await sleep(retryAfterMs(response.headers));
	}
}

export class MailProbe implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'MailProbe',
		name: 'mailProbe',
		icon: { light: 'file:mailprobe.svg', dark: 'file:mailprobe.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description:
			'Verify email addresses with MailProbe: deliverability, disposable and role-based detection',
		defaults: {
			name: 'MailProbe',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'mailProbeApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Email', value: 'email' },
					{ name: 'Account', value: 'account' },
				],
				default: 'email',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['email'] } },
				options: [
					{
						name: 'Verify',
						value: 'verify',
						description: 'Verify an email address',
						action: 'Verify an email address',
					},
				],
				default: 'verify',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['account'] } },
				options: [
					{
						name: 'Get Credits',
						value: 'getCredits',
						description: 'Get the remaining credit balance',
						action: 'Get the remaining credit balance',
					},
				],
				default: 'getCredits',
			},
			{
				displayName: 'Email',
				name: 'email',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'name@example.com',
				description: 'The email address to verify',
				displayOptions: { show: { resource: ['email'], operation: ['verify'] } },
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;
		const continueOnFail = this.continueOnFail();

		// Indexed by input item, so the output keeps the input order.
		const results: Array<INodeExecutionData | undefined> = new Array(items.length);

		const fail = (itemIndex: number, error: NodeError, json: IDataObject = {}) => {
			if (!continueOnFail) throw error;
			results[itemIndex] = {
				json: { ...json, error: error.message },
				pairedItem: { item: itemIndex },
			};
		};

		const apiError = (response: FullResponse, itemIndex: number): NodeApiError => {
			const body = isObject(response.body) ? response.body : {};
			const apiMessage = typeof body.error === 'string' ? body.error : undefined;
			const { message, description } = describeError(
				response.statusCode,
				errorCode(response),
				apiMessage,
			);
			return new NodeApiError(this.getNode(), body as JsonObject, {
				message,
				description,
				httpCode: String(response.statusCode),
				itemIndex,
			});
		};

		if (resource === 'account' && operation === 'getCredits') {
			for (let i = 0; i < items.length; i++) {
				let response: FullResponse;
				try {
					response = await mailProbeRequest.call(this, 'GET', '/api/v1/credits');
				} catch (error) {
					fail(i, new NodeApiError(this.getNode(), error as JsonObject, { itemIndex: i }));
					continue;
				}
				if (response.statusCode === 200 && isObject(response.body)) {
					results[i] = { json: response.body, pairedItem: { item: i } };
				} else {
					fail(i, apiError(response, i));
				}
			}
		} else if (resource === 'email' && operation === 'verify') {
			const pending: PendingEmail[] = [];
			for (let i = 0; i < items.length; i++) {
				const email = String(this.getNodeParameter('email', i, '') ?? '').trim();
				if (email === '') {
					fail(
						i,
						new NodeOperationError(this.getNode(), 'The Email parameter is empty', {
							itemIndex: i,
							description:
								'Map a field that holds an email address, for example {{ $json.email }}.',
						}),
						{ email },
					);
					continue;
				}
				pending.push({ itemIndex: i, email });
			}

			// Set once nothing more can succeed in this run: the key is rejected, the credits are
			// spent, the rate limit persists or MailProbe is unreachable. Remaining items get this
			// error without another request.
			let stopError: NodeApiError | undefined;
			// Domains the account may not verify with its current credits (PAID_ONLY_DOMAIN).
			const refusedDomains = new Map<string, NodeApiError>();

			const verifyBatch = async (batch: PendingEmail[]): Promise<void> => {
				const toSend: PendingEmail[] = [];
				for (const entry of batch) {
					const refused = stopError ?? refusedDomains.get(domainOf(entry.email));
					if (refused) fail(entry.itemIndex, refused, { email: entry.email });
					else toSend.push(entry);
				}
				if (toSend.length === 0) return;

				let response: FullResponse;
				try {
					response = await mailProbeRequest.call(this, 'POST', '/api/v1/verify', {
						emails: toSend.map((entry) => entry.email),
					});
				} catch (error) {
					// No HTTP response at all (network failure or timeout). Not retried: addresses
					// MailProbe had already probed are billed, a second attempt would bill them again.
					stopError = new NodeApiError(this.getNode(), error as JsonObject, {
						itemIndex: toSend[0].itemIndex,
					});
					for (const entry of toSend) fail(entry.itemIndex, stopError, { email: entry.email });
					return;
				}

				if (response.statusCode === 200) {
					const entries = response.body;
					if (!Array.isArray(entries) || entries.length !== toSend.length) {
						const unexpected = new NodeApiError(
							this.getNode(),
							{ response: JSON.stringify(entries) },
							{
								message: 'Unexpected response from MailProbe',
								itemIndex: toSend[0].itemIndex,
							},
						);
						for (const entry of toSend) fail(entry.itemIndex, unexpected, { email: entry.email });
						return;
					}
					toSend.forEach((entry, k) => {
						results[entry.itemIndex] = {
							json: entries[k] as IDataObject,
							pairedItem: { item: entry.itemIndex },
						};
					});
					return;
				}

				if (response.statusCode === 402 && toSend.length > 1) {
					// One address can block the whole request (a domain reserved for purchased
					// credits), or the balance can cover only part of it: go one address at a time.
					for (const entry of toSend) await verifyBatch([entry]);
					return;
				}

				const error = apiError(response, toSend[0].itemIndex);
				const code = errorCode(response);
				if (code === 'PAID_ONLY_DOMAIN') {
					refusedDomains.set(domainOf(toSend[0].email), error);
				} else if (
					code === 'UNAUTHORIZED' ||
					code === 'NO_CREDITS' ||
					response.statusCode === 429
				) {
					stopError = error;
				}
				for (const entry of toSend) fail(entry.itemIndex, error, { email: entry.email });
			};

			for (let start = 0; start < pending.length; start += MAX_EMAILS_PER_REQUEST) {
				await verifyBatch(pending.slice(start, start + MAX_EMAILS_PER_REQUEST));
			}
		} else {
			throw new NodeOperationError(
				this.getNode(),
				`The operation "${operation}" is not supported for the resource "${resource}"`,
			);
		}

		return [results.filter((result): result is INodeExecutionData => result !== undefined)];
	}
}
