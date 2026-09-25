import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class MailProbeApi implements ICredentialType {
	name = 'mailProbeApi';

	displayName = 'MailProbe API';

	icon: Icon = {
		light: 'file:../nodes/MailProbe/mailprobe.svg',
		dark: 'file:../nodes/MailProbe/mailprobe.dark.svg',
	};

	documentationUrl = 'https://github.com/jamalofski/n8n-nodes-mailprobe#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			placeholder: 'mp_live_...',
			description:
				'Your MailProbe API key. Copy it from the API keys section of your MailProbe dashboard.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	// Reading the balance is free: it checks the key without spending a credit.
	test: ICredentialTestRequest = {
		request: {
			baseURL: 'https://mailprobe.dev',
			url: '/api/v1/credits',
			method: 'GET',
		},
	};
}
