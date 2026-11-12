import { expect, test } from 'bun:test';

interface Resource {
    Type: string;
    DeletionPolicy?: string;
    UpdateReplacePolicy?: string;
    Properties: Record<string, unknown>;
}

interface Serverless {
    service: string;
    provider: {
        runtime: string;
        architecture: string;
        region: string;
        stage: string;
        memorySize: number;
        timeout: number;
        logRetentionInDays: number;
        iam: { role: string };
        environment: Record<string, unknown>;
    };
    resources: { Resources: Record<string, Resource> };
    functions: { api: { handler: string; url: boolean } };
    package: { artifact: string };
}

interface PolicyStatement {
    Effect?: string;
    Action: string | string[];
    Resource: unknown;
    Condition?: unknown;
}

interface CloudFrontConfig {
    Aliases: unknown[];
    ViewerCertificate: Record<string, unknown>;
    Origins: { DomainName: unknown; CustomOriginConfig: Record<string, unknown> }[];
    DefaultCacheBehavior: Record<string, unknown>;
    CacheBehaviors: Record<string, unknown>[];
    CustomErrorResponses: { ErrorCode: number; ErrorCachingMinTTL: number; ResponseCode?: number; ResponsePagePath?: string }[];
    WebACLId?: string;
}

interface Bootstrap {
    Parameters: Record<string, Record<string, unknown>>;
    Resources: Record<string, Resource>;
    Outputs: Record<string, unknown>;
}

interface WorkflowStep {
    name?: string;
    uses?: string;
    run?: string;
    if?: string;
    env?: Record<string, string>;
    with?: Record<string, string>;
}

interface WorkflowJob {
    if?: string;
    needs?: string | string[];
    permissions?: Record<string, string>;
    steps: WorkflowStep[];
}

interface Workflow {
    permissions: Record<string, string>;
    on: { push: { branches: string[] }; pull_request: { branches: string[] } };
    jobs: Record<string, WorkflowJob>;
}

const sources = {
    serverless: await Bun.file('serverless.yml').text(),
    bootstrap: await Bun.file('infra/bootstrap.yml').text(),
    workflow: await Bun.file('.github/workflows/ci.yml').text(),
    deploy: await Bun.file('scripts/deploy.sh').text(),
    verify: await Bun.file('scripts/verify-deployment.mjs').text(),
};
const configuration = Bun.YAML.parse(sources.serverless) as Serverless;
const bootstrap = Bun.YAML.parse(sources.bootstrap) as Bootstrap;
const workflow = Bun.YAML.parse(sources.workflow) as Workflow;
const cloudFront = bootstrap.Resources['PublicDistribution']?.Properties['DistributionConfig'] as CloudFrontConfig;

function statementsOf(roleName: string): PolicyStatement[] {
    const policies = bootstrap.Resources[roleName]?.Properties['Policies'] as { PolicyDocument: { Statement: PolicyStatement[] } }[];
    return policies.flatMap((policy) => policy.PolicyDocument.Statement);
}

function actionsOf(statement: PolicyStatement): string[] {
    return typeof statement.Action === 'string' ? [statement.Action] : statement.Action;
}

const logGroup = 'arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/lambda/caldav-mcp-prod-api';
const tableArn = 'arn:${AWS::Partition}:dynamodb:${AWS::Region}:${AWS::AccountId}:table/caldav-mcp-prod-state';
const keyringArn = 'arn:${AWS::Partition}:ssm:${AWS::Region}:${AWS::AccountId}:parameter/caldav-mcp/prod/auth-keyring';

test('deployment keeps the agreed tiny footprint without hidden indexes or scaling resources', () => {
    expect(configuration.service).toBe('caldav-mcp');
    expect(configuration.provider.runtime).toBe('nodejs26.x');
    expect(configuration.provider.architecture).toBe('arm64');
    expect(configuration.provider.region).toBe('us-west-2');
    expect(configuration.provider.stage).toBe('prod');
    expect(configuration.provider.memorySize).toBe(1024);
    expect(configuration.provider.timeout).toBe(60);
    expect(configuration.provider.logRetentionInDays).toBe(14);
    expect(configuration.functions.api.url).toBe(true);
    expect(configuration.package.artifact).toBe('dist/function.zip');
    const resources = Object.values(configuration.resources.Resources);
    expect(resources.filter((resource) => resource.Type === 'AWS::DynamoDB::Table')).toHaveLength(1);
    expect(resources.some((resource) => resource.Type.startsWith('AWS::ApplicationAutoScaling::'))).toBe(false);
    const table = configuration.resources.Resources['CredentialTable'];
    expect(table?.Properties['TableName']).toBe('${self:service}-${sls:stage}-state');
    expect(table?.Properties['ProvisionedThroughput']).toEqual({ ReadCapacityUnits: 1, WriteCapacityUnits: 1 });
    expect(table?.Properties['BillingMode']).toBe('PROVISIONED');
    expect(table?.Properties['GlobalSecondaryIndexes']).toBeUndefined();
    expect(table?.Properties['LocalSecondaryIndexes']).toBeUndefined();
    expect(table?.DeletionPolicy).toBe('Retain');
    expect(table?.UpdateReplacePolicy).toBe('Retain');
});

test('function environment is the caldav set with a fail-closed allowlist, the imported download bucket and no mail settings', () => {
    const environment = configuration.provider.environment;
    expect(Object.keys(environment).toSorted()).toEqual(['ALLOWED_APPLE_ID_HASHES', 'AUTH_KEYRING_PARAMETER', 'CREDENTIAL_TABLE_NAME', 'DOWNLOAD_BUCKET_NAME', 'PUBLIC_BASE_URL']);
    expect(environment['DOWNLOAD_BUCKET_NAME']).toEqual({ 'Fn::ImportValue': 'caldav-mcp-prod-download-bucket' });
    expect(environment['PUBLIC_BASE_URL']).toEqual({ 'Fn::ImportValue': 'caldav-mcp-prod-public-origin' });
    expect(environment['CREDENTIAL_TABLE_NAME']).toEqual({ Ref: 'CredentialTable' });
    expect(environment['AUTH_KEYRING_PARAMETER']).toBe("${env:AUTH_KEYRING_PARAMETER, ''}");
    // An unset repository variable must deploy as an empty allowlist: nobody may connect.
    expect(environment['ALLOWED_APPLE_ID_HASHES']).toBe("${env:ALLOWED_APPLE_ID_HASHES, ''}");
    expect(sources.serverless).not.toMatch(/WILDDUCK_/);
});

test('no repository infrastructure file still carries wildduck naming', () => {
    for (const [name, text] of Object.entries(sources)) {
        expect([name, /wildduck/i.test(text)]).toEqual([name, false]);
    }
});

test('the download bucket is a separate private, encrypted, unversioned bucket in the bootstrap stack with one-day expiry', () => {
    const buckets = Object.entries(bootstrap.Resources).filter(([, resource]) => resource.Type === 'AWS::S3::Bucket').map(([name]) => name);
    expect(buckets.toSorted()).toEqual(['ArtifactBucket', 'DownloadBucket']);
    const bucket = bootstrap.Resources['DownloadBucket'];
    expect(Object.keys(bucket?.Properties ?? {}).toSorted()).toEqual(['BucketEncryption', 'LifecycleConfiguration', 'OwnershipControls', 'PublicAccessBlockConfiguration', 'Tags']);
    expect(bucket?.Properties['OwnershipControls']).toEqual({ Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] });
    expect(bucket?.Properties['PublicAccessBlockConfiguration']).toEqual({ BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true });
    expect(bucket?.Properties['BucketEncryption']).toEqual({ ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] });
    expect(bucket?.Properties['LifecycleConfiguration']).toEqual({ Rules: [{ Id: 'ExpireStagedDownloads', Status: 'Enabled', Prefix: 'downloads/', ExpirationInDays: 1, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } }] });
    // No versioning (an old version would outlive the expiry), no CORS, no website, no fixed name.
    for (const absent of ['VersioningConfiguration', 'CorsConfiguration', 'WebsiteConfiguration', 'BucketName', 'AccessControl']) { expect(bucket?.Properties[absent]).toBeUndefined(); }
    // Staged copies are disposable: the bucket is not retained when the stack is deleted.
    expect(bucket?.DeletionPolicy).toBe('Delete');
    expect(bucket?.UpdateReplacePolicy).toBe('Delete');
    const policies = Object.entries(bootstrap.Resources).filter(([, resource]) => resource.Type === 'AWS::S3::BucketPolicy');
    expect(policies.map(([name]) => name)).toEqual(['DownloadBucketPolicy']);
    const policy = bootstrap.Resources['DownloadBucketPolicy']?.Properties ?? {};
    expect(policy['Bucket']).toEqual({ Ref: 'DownloadBucket' });
    expect((policy['PolicyDocument'] as { Statement: unknown[] }).Statement).toEqual([{
        Sid: 'RequireTLS', Effect: 'Deny', Principal: '*', Action: 's3:*',
        Resource: [{ 'Fn::GetAtt': ['DownloadBucket', 'Arn'] }, { 'Fn::Sub': '${DownloadBucket.Arn}/*' }],
        Condition: { Bool: { 'aws:SecureTransport': false } },
    }]);
    expect(bootstrap.Outputs['DownloadBucketName']).toEqual({ Value: { Ref: 'DownloadBucket' }, Export: { Name: 'caldav-mcp-prod-download-bucket' } });
    expect(Object.values(configuration.resources.Resources).some((resource) => resource.Type.startsWith('AWS::S3::'))).toBe(false);
});

test('the CI deploy role gains no download bucket data or control permissions', () => {
    const deploy = JSON.stringify(bootstrap.Resources['GitHubDeployRole']);
    expect(deploy).not.toMatch(/DownloadBucket|downloads\//);
    const s3Resources = statementsOf('GitHubDeployRole').filter((statement) => actionsOf(statement).some((action) => action.startsWith('s3:'))).map((statement) => statement.Resource);
    expect(s3Resources).toEqual([{ 'Fn::GetAtt': ['ArtifactBucket', 'Arn'] }, { 'Fn::Sub': '${ArtifactBucket.Arn}/serverless/caldav-mcp/prod/*' }]);
});

test('the live verification checks that the function received the download bucket', () => {
    expect(sources.verify).toContain('DOWNLOAD_BUCKET_NAME');
});

test('deployment can discover log groups without granting account-wide log mutations', () => {
    const statements = statementsOf('GitHubDeployRole');
    const globalLogActions = statements.filter((statement) => statement.Resource === '*')
        .flatMap(actionsOf)
        .filter((action) => action.startsWith('logs:'));
    expect(globalLogActions).toEqual(['logs:DescribeLogGroups']);
    const logMutations = statements.filter((statement) => Array.isArray(statement.Action) && statement.Action.includes('logs:*'));
    expect(logMutations).toHaveLength(1);
    expect(logMutations[0]?.Resource).toEqual([
        { 'Fn::Sub': logGroup },
        { 'Fn::Sub': `${logGroup}:*` },
    ]);
});

test('deploy role is scoped to the caldav-mcp stack, function, log group, table and artifact prefix only', () => {
    const statements = statementsOf('GitHubDeployRole');
    const sub = (value: string) => ({ 'Fn::Sub': value });
    const byAction = (action: string) => statements.find((statement) => actionsOf(statement).includes(action));
    expect(byAction('cloudformation:CreateChangeSet')?.Resource).toEqual(sub('arn:${AWS::Partition}:cloudformation:${AWS::Region}:${AWS::AccountId}:stack/caldav-mcp-prod/*'));
    expect(byAction('s3:PutObject')?.Resource).toEqual(sub('${ArtifactBucket.Arn}/serverless/caldav-mcp/prod/*'));
    expect(byAction('lambda:*')?.Resource).toEqual([
        sub('arn:${AWS::Partition}:lambda:${AWS::Region}:${AWS::AccountId}:function:caldav-mcp-prod-api'),
        sub('arn:${AWS::Partition}:lambda:${AWS::Region}:${AWS::AccountId}:function:caldav-mcp-prod-api:*'),
    ]);
    expect(byAction('dynamodb:DescribeTable')?.Resource).toEqual(sub(tableArn));
    expect(byAction('iam:PassRole')?.Resource).toEqual({ 'Fn::GetAtt': ['ExecutionRole', 'Arn'] });
    // The only unscoped statements are the two read-only discovery/validation calls.
    const unscoped = statements.filter((statement) => statement.Resource === '*').flatMap(actionsOf);
    expect(unscoped.toSorted()).toEqual(['cloudformation:ValidateTemplate', 'logs:DescribeLogGroups']);
});

test('deploy role manages the state table control plane only and explicitly cannot read, change or destroy its data or the keyring', () => {
    const statements = statementsOf('GitHubDeployRole');
    const sub = (value: string) => ({ 'Fn::Sub': value });
    const withEffect = (effect: string) => statements.filter((statement) => statement.Effect === effect);
    const dynamoActions = (list: PolicyStatement[]) => list.flatMap(actionsOf).filter((action) => action.startsWith('dynamodb:'));

    // No dynamodb wildcard in any statement, in any effect, in any spelling.
    expect(JSON.stringify(bootstrap.Resources['GitHubDeployRole'])).not.toMatch(/dynamodb:[A-Za-z]*\*/);

    // Allow: exactly the control-plane actions CloudFormation needs for the table in serverless.yml.
    const allows = withEffect('Allow').filter((statement) => dynamoActions([statement]).length > 0);
    expect(allows).toHaveLength(1);
    expect(allows[0]?.Resource).toEqual(sub(tableArn));
    expect(allows[0]?.Condition).toBeUndefined();
    const allowed = dynamoActions(allows);
    expect(allowed.toSorted()).toEqual([
        'dynamodb:CreateTable',
        'dynamodb:DescribeContinuousBackups',
        'dynamodb:DescribeContributorInsights',
        'dynamodb:DescribeKinesisStreamingDestination',
        'dynamodb:DescribeTable',
        'dynamodb:DescribeTimeToLive',
        'dynamodb:ListTagsOfResource',
        'dynamodb:TagResource',
        'dynamodb:UntagResource',
        'dynamodb:UpdateContinuousBackups',
        'dynamodb:UpdateTable',
        'dynamodb:UpdateTimeToLive',
    ]);
    const dataPlaneAndDestructive = [
        'GetItem', 'BatchGetItem', 'Query', 'Scan', 'PutItem', 'UpdateItem', 'DeleteItem', 'BatchWriteItem',
        'TransactGetItems', 'TransactWriteItems', 'PartiQLSelect', 'PartiQLInsert', 'PartiQLUpdate', 'PartiQLDelete',
        'ExportTableToPointInTime', 'GetRecords', 'GetShardIterator', 'DescribeStream', 'DeleteTable',
        'CreateBackup', 'RestoreTableFromBackup', 'RestoreTableToPointInTime',
    ].map((action) => `dynamodb:${action}`);
    for (const action of dataPlaneAndDestructive) {
        expect(allowed).not.toContain(action);
    }

    // Deny: the same data-plane and destructive actions on the table and every sub-resource (indexes, streams, backups).
    const tableDenies = withEffect('Deny').filter((statement) => dynamoActions([statement]).length > 0);
    expect(tableDenies).toHaveLength(1);
    expect(actionsOf(tableDenies[0] as PolicyStatement).toSorted()).toEqual(dataPlaneAndDestructive.toSorted());
    expect(tableDenies[0]?.Resource).toEqual([sub(tableArn), sub(`${tableArn}/*`)]);
    expect(tableDenies[0]?.Condition).toBeUndefined();

    // Deny: the keyring parameter cannot be read, written or deleted through this role, even if a later allow broadens.
    const keyringDenies = withEffect('Deny').filter((statement) => actionsOf(statement).some((action) => action.startsWith('ssm:')));
    expect(keyringDenies).toHaveLength(1);
    expect(actionsOf(keyringDenies[0] as PolicyStatement).toSorted()).toEqual(['ssm:DeleteParameter*', 'ssm:GetParameter*', 'ssm:PutParameter']);
    expect(keyringDenies[0]?.Resource).toEqual(sub(keyringArn));
    expect(withEffect('Allow').some((statement) => actionsOf(statement).some((action) => action.startsWith('ssm:')))).toBe(false);

    // Every Deny is for one of the two protected resources and nothing else.
    expect(withEffect('Deny')).toHaveLength(2);
    // The residual risk is documented next to the policy, truthfully.
    expect(sources.bootstrap).toContain('lambda:* on the function');
    expect(sources.bootstrap).toContain('inside the trust boundary');
});

test('runtime IAM has exactly logs, one keyring parameter read, leading-key-scoped table item access and download-prefix put/get, no action wildcards', () => {
    const statements = statementsOf('ExecutionRole');
    const sub = (value: string) => ({ 'Fn::Sub': value });
    expect(statements).toEqual([
        { Effect: 'Allow', Action: ['logs:CreateLogStream', 'logs:PutLogEvents'], Resource: sub(`${logGroup}:*`) },
        { Effect: 'Allow', Action: 'ssm:GetParameter', Resource: sub('arn:${AWS::Partition}:ssm:${AWS::Region}:${AWS::AccountId}:parameter/caldav-mcp/prod/auth-keyring') },
        {
            Effect: 'Allow',
            Action: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:ConditionCheckItem'],
            Resource: sub('arn:${AWS::Partition}:dynamodb:${AWS::Region}:${AWS::AccountId}:table/caldav-mcp-prod-state'),
            Condition: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['caldav-mcp#*'] } },
        },
        { Effect: 'Allow', Action: ['s3:PutObject', 's3:GetObject'], Resource: sub('${DownloadBucket.Arn}/downloads/*') },
    ]);
    for (const statement of statements) {
        expect(statement.Resource).not.toBe('*');
        expect(actionsOf(statement).some((action) => action.endsWith('*'))).toBe(false);
    }
    // The only resource wildcards are the function's own log streams and the download prefix of the download bucket.
    const wildcardResources = statements.map((statement) => JSON.stringify(statement.Resource)).filter((resource) => resource.includes('*'));
    expect(wildcardResources).toEqual([JSON.stringify(sub(`${logGroup}:*`)), JSON.stringify(sub('${DownloadBucket.Arn}/downloads/*'))]);
    // No list, delete, ACL, policy or multipart action on any bucket.
    const s3Actions = statements.flatMap(actionsOf).filter((action) => action.startsWith('s3:'));
    expect(s3Actions).toEqual(['s3:PutObject', 's3:GetObject']);
});

test('OIDC trust binds the actual immutable repository identity and main branch only', () => {
    const document = bootstrap.Resources['GitHubDeployRole']?.Properties['AssumeRolePolicyDocument'] as { Statement: { Action: string; Condition: unknown }[] } | undefined;
    const trust = document?.Statement ?? [];
    expect(trust).toHaveLength(1);
    expect(trust[0]?.Action).toBe('sts:AssumeRoleWithWebIdentity');
    expect(trust[0]?.Condition).toEqual({
        StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
            'token.actions.githubusercontent.com:sub': 'repo:hughescr@46348/caldav-mcp@1454444258:ref:refs/heads/main',
        },
    });
    expect(sources.bootstrap).toContain('gh api repos/hughescr/caldav-mcp/actions/oidc/customization/sub');
});

test('bootstrap pins the public hostname to caldav-mcp.rungie.com and builds the challenge header and exported origin from it', () => {
    const parameter = bootstrap.Parameters['PublicDomainName'];
    expect(parameter?.['Type']).toBe('String');
    expect(parameter?.['Default']).toBe('caldav-mcp.rungie.com');
    expect(parameter?.['AllowedValues']).toEqual(['caldav-mcp.rungie.com']);
    expect(parameter?.['AllowedPattern']).toBeUndefined();
    expect(parameter?.['Description']).toBe('Approved stable public OAuth hostname');
    const bearer = bootstrap.Resources['BearerResponseHeaders']?.Properties['ResponseHeadersPolicyConfig'] as { CustomHeadersConfig: { Items: { Value: unknown }[] } };
    expect(bearer.CustomHeadersConfig.Items[0]?.Value).toEqual({ 'Fn::Sub': 'Bearer resource_metadata="https://${PublicDomainName}/.well-known/oauth-protected-resource/mcp"' });
    expect(bootstrap.Outputs['PublicBaseUrl']).toEqual({ Value: { 'Fn::Sub': 'https://${PublicDomainName}' }, Export: { Name: 'caldav-mcp-prod-public-origin' } });
    // The hostname is written once, as the parameter's Default and its single allowed value.
    expect(sources.bootstrap.match(/caldav-mcp\.rungie\.com/g)).toHaveLength(2);
    expect(JSON.stringify(configuration)).not.toMatch(/\.rungie\.com/);
});

test('CloudFront uses the approved shared certificate and DNS pattern with an independent canonical origin', () => {
    expect(bootstrap.Parameters['HostedZoneId']?.['Default']).toBe('Z1VXUCOF8PCGCR');
    expect(bootstrap.Parameters['HostedZoneId']?.['AllowedValues']).toEqual(['Z1VXUCOF8PCGCR']);
    expect(cloudFront.Aliases).toEqual([{ Ref: 'PublicDomainName' }]);
    expect(cloudFront.ViewerCertificate).toEqual({ AcmCertificateArn: { Ref: 'SSLCertificate' }, SslSupportMethod: 'sni-only', MinimumProtocolVersion: 'TLSv1.2_2021' });
    const certificate = bootstrap.Resources['SSLCertificate'];
    expect(certificate?.Type).toBe('Custom::DNSCertificate');
    expect(certificate?.Properties['Region']).toBe('us-east-1');
    expect(certificate?.Properties['ServiceToken']).toEqual({ 'Fn::ImportValue': 'CertificateAccepterLambda-Arn' });
    expect(certificate?.DeletionPolicy).toBe('Retain');
    expect(certificate?.UpdateReplacePolicy).toBe('Retain');
    for (const [name, type] of [['PublicDnsA', 'A'], ['PublicDnsAAAA', 'AAAA']]) {
        const dns = bootstrap.Resources[name ?? ''];
        expect(dns?.Properties['Type']).toBe(type);
        expect(dns?.Properties['Name']).toEqual({ Ref: 'PublicDomainName' });
        expect(dns?.Properties['HostedZoneId']).toEqual({ Ref: 'HostedZoneId' });
        expect(dns?.Properties['AliasTarget']).toEqual({ DNSName: { 'Fn::GetAtt': ['PublicDistribution', 'DomainName'] }, HostedZoneId: 'Z2FDTNDATAQYW2' });
    }
    expect(configuration.provider.environment['PUBLIC_BASE_URL']).toEqual({ 'Fn::ImportValue': 'caldav-mcp-prod-public-origin' });
    expect(bootstrap.Outputs['PublicBaseUrl']).toEqual({ Value: { 'Fn::Sub': 'https://${PublicDomainName}' }, Export: { Name: 'caldav-mcp-prod-public-origin' } });
    expect(JSON.stringify(bootstrap)).not.toContain('Fn::ImportValue":"ApiLambdaFunction');
    const exports = Object.values(bootstrap.Outputs).filter((output) => typeof output === 'object' && output !== null && 'Export' in output);
    expect(exports.map((output) => (output as { Export: { Name: string } }).Export.Name).toSorted()).toEqual(['caldav-mcp-prod-download-bucket', 'caldav-mcp-prod-public-origin']);
});

test('all OAuth ingress paths disable caching and forward auth, cookies, origin and query metadata', () => {
    expect(cloudFront.Origins).toHaveLength(1);
    expect(cloudFront.Origins[0]?.DomainName).toEqual({ 'Fn::Select': [2, { 'Fn::Split': ['/', { Ref: 'FunctionUrlOrigin' }] }] });
    expect(cloudFront.Origins[0]?.CustomOriginConfig).toEqual({ OriginProtocolPolicy: 'https-only', OriginSSLProtocols: ['TLSv1.2'], OriginReadTimeout: 60 });
    expect(cloudFront.CacheBehaviors.map((behavior) => behavior['PathPattern'])).toEqual(['/token', '/revoke']);
    for (const behavior of [cloudFront.DefaultCacheBehavior, ...cloudFront.CacheBehaviors]) {
        expect(behavior['AllowedMethods']).toEqual(['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'POST', 'DELETE']);
        expect(behavior['CachePolicyId']).toBe('4135ea2d-6df8-44a3-9df3-4b5a84be39ad');
        expect(behavior['OriginRequestPolicyId']).toBe('b689b0a8-53d0-40ab-baf2-68738e2966ac');
        expect(behavior['ViewerProtocolPolicy']).toBe('https-only');
        expect(behavior['FunctionAssociations']).toBeUndefined();
        expect(behavior['LambdaFunctionAssociations']).toBeUndefined();
    }
    const supportedErrors = [400, 403, 404, 405, 414, 416, 500, 501, 502, 503, 504];
    expect(cloudFront.CustomErrorResponses.map((error) => error.ErrorCode)).toEqual(supportedErrors);
    for (const error of cloudFront.CustomErrorResponses) {
        expect(error.ErrorCachingMinTTL).toBe(0);
        expect(error.ResponseCode).toBeUndefined();
        expect(error.ResponsePagePath).toBeUndefined();
    }
});

test('edge policies restore real challenge headers without overriding origin security headers or granting CI CloudFront control', () => {
    expect(cloudFront.DefaultCacheBehavior['ResponseHeadersPolicyId']).toEqual({ Ref: 'BearerResponseHeaders' });
    for (const behavior of cloudFront.CacheBehaviors) {
        expect(behavior['ResponseHeadersPolicyId']).toEqual({ Ref: 'BasicResponseHeaders' });
    }
    const header = (name: string) => bootstrap.Resources[name]?.Properties['ResponseHeadersPolicyConfig'] as { Name: string; CustomHeadersConfig: { Items: unknown[] }; SecurityHeadersConfig?: unknown; CorsConfig?: unknown };
    expect(header('BearerResponseHeaders').Name).toBe('caldav-mcp-prod-bearer');
    expect(header('BasicResponseHeaders').Name).toBe('caldav-mcp-prod-basic');
    expect(header('BearerResponseHeaders').CustomHeadersConfig.Items).toEqual([{ Header: 'WWW-Authenticate', Value: { 'Fn::Sub': 'Bearer resource_metadata="https://${PublicDomainName}/.well-known/oauth-protected-resource/mcp"' }, Override: false }]);
    expect(header('BasicResponseHeaders').CustomHeadersConfig.Items).toEqual([{ Header: 'WWW-Authenticate', Value: 'Basic realm="oauth"', Override: false }]);
    for (const name of ['BearerResponseHeaders', 'BasicResponseHeaders']) {
        expect(header(name).SecurityHeadersConfig).toBeUndefined();
        expect(header(name).CorsConfig).toBeUndefined();
    }
    expect(Object.values(bootstrap.Resources).filter((resource) => resource.Type === 'AWS::CloudFront::ResponseHeadersPolicy')).toHaveLength(2);
    expect(Object.values(bootstrap.Resources).some((resource) => /AWS::(?:ApiGateway|WAF|CloudFront::Function)/.test(resource.Type))).toBe(false);
    const role = JSON.stringify(bootstrap.Resources['GitHubDeployRole']);
    expect(role).not.toContain('cloudfront:');
    expect(role).not.toContain('apigateway:');
    expect(role).not.toContain('CertificateAccepterLambda-Arn');
    expect(cloudFront.WebACLId).toBeUndefined();
});

test('every caldav-mcp resource name in bootstrap uses the caldav-mcp prefix', () => {
    expect(bootstrap.Resources['ExecutionRole']?.Properties['RoleName']).toBe('caldav-mcp-prod-execution');
    expect(bootstrap.Resources['GitHubDeployRole']?.Properties['RoleName']).toBe('caldav-mcp-github-deploy');
    expect(configuration.provider.iam.role).toContain('caldav-mcp-prod-execution');
    expect(JSON.stringify(bootstrap.Resources['PublicDistribution'])).toContain('caldav-mcp canonical OAuth endpoint');
});

test('CI verify job is credential-free; deploy runs only on main with DEPLOY_ENABLED and exact-artifact OIDC', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.on.push.branches).toEqual(['main', 'develop']);
    expect(workflow.on.pull_request.branches).toEqual(['main', 'develop']);
    const verify = workflow.jobs['verify'];
    expect(verify).toBeDefined();
    expect(verify?.permissions).toBeUndefined();
    expect(verify?.if).toBeUndefined();
    const verifyText = JSON.stringify(verify);
    expect(verifyText).not.toMatch(/id-token|configure-aws-credentials|secrets\.|AWS_|vars\./);
    const deploy = workflow.jobs['deploy'];
    expect(deploy?.if).toContain("github.ref == 'refs/heads/main'");
    expect(deploy?.if).toContain("vars.DEPLOY_ENABLED == 'true'");
    expect(deploy?.if).toContain("github.event_name != 'pull_request'");
    expect(deploy?.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    expect(deploy?.needs).toEqual(['verify', 'deployment-status']);
    const steps = deploy?.steps ?? [];
    expect(steps.some((step) => step.uses?.startsWith('actions/download-artifact@'))).toBe(true);
    expect(steps.some((step) => step.uses?.startsWith('aws-actions/configure-aws-credentials@'))).toBe(true);
    expect(steps.find((step) => step.name === 'Deploy verified artifact')?.run).toBe('bun run deploy');
});

test('CI keeps deployment disabled by default and never defaults DEPLOY_ENABLED on', () => {
    const references = sources.workflow.split('\n').filter((line) => line.includes('DEPLOY_ENABLED'));
    const conditions = references.filter((line) => line.includes('vars.DEPLOY_ENABLED'));
    expect(conditions.length).toBeGreaterThanOrEqual(3);
    for (const line of conditions) {
        expect(line).toMatch(/vars\.DEPLOY_ENABLED (?:==|!=) 'true'/);
        expect(line).not.toContain('||');
    }
    // The only other mention is the human-readable summary text.
    expect(references.filter((line) => !line.includes('vars.DEPLOY_ENABLED'))).toHaveLength(1);
    expect(sources.workflow).not.toMatch(/^\s*DEPLOY_ENABLED\s*:/m);
    expect(sources.workflow).not.toMatch(/GITHUB_ENV|GITHUB_OUTPUT/);
});

test('CI toolchain pins and the allowlist and keyring variable checks', () => {
    for (const job of ['verify', 'deploy']) {
        const steps = workflow.jobs[job]?.steps ?? [];
        expect(steps.find((step) => step.uses?.startsWith('oven-sh/setup-bun@'))?.with?.['bun-version']).toBe('1.4.4');
        expect(steps.find((step) => step.uses?.startsWith('actions/setup-node@'))?.with?.['node-version']).toBe('26');
        expect(steps.find((step) => step.run === 'bun install --frozen-lockfile --ignore-scripts')).toBeDefined();
    }
    expect(workflow.jobs['verify']?.steps.some((step) => step.run === 'bun run validate')).toBe(true);
    const validation = workflow.jobs['deployment-status']?.steps.find((step) => step.name === 'Validate deployment variables');
    expect(validation?.if).toBe("vars.DEPLOY_ENABLED == 'true'");
    expect(validation?.env?.['ALLOWED_APPLE_ID_HASHES']).toBe('${{ vars.ALLOWED_APPLE_ID_HASHES }}');
    expect(validation?.run).toContain('test -n "$ALLOWED_APPLE_ID_HASHES"');
    expect(validation?.run).toContain('test "$AUTH_KEYRING_PARAMETER" = /caldav-mcp/prod/auth-keyring');
    const deploy = workflow.jobs['deploy']?.steps.find((step) => step.name === 'Deploy verified artifact');
    expect(deploy?.env?.['ALLOWED_APPLE_ID_HASHES']).toBe('${{ vars.ALLOWED_APPLE_ID_HASHES }}');
    expect(deploy?.env?.['AUTH_KEYRING_PARAMETER']).toBe('${{ vars.AUTH_KEYRING_PARAMETER }}');
    expect(deploy?.env?.['AUTH_KEYRING_PARAMETER']).not.toContain('||');
    expect(deploy?.env?.['ALLOWED_APPLE_ID_HASHES']).not.toContain('||');
});

test('deploy script pins the keyring parameter and the verifier checks caldav-mcp live settings without printing them', () => {
    expect(sources.deploy).toContain("[[ \"$AUTH_KEYRING_PARAMETER\" == '/caldav-mcp/prod/auth-keyring' ]]");
    expect(sources.deploy).toContain('node_modules/.bin/serverless deploy --stage prod');
    expect(sources.verify).toContain("'caldav-mcp-prod'");
    expect(sources.verify).toContain("'caldav-mcp-prod-api'");
    expect(sources.verify).toContain("service: 'caldav-mcp'");
    expect(sources.verify).toContain("scope: 'calendar:read'");
    expect(sources.verify).toContain('/auth/connect');
    expect(sources.verify).toContain("'decision', 'cancel'");
    expect(sources.verify).toContain('ALLOWED_APPLE_ID_HASHES');
    // The live allowlist value must never reach an assertion message or output.
    expect(sources.verify).not.toMatch(/console\.|process\.stdout|process\.stderr/);
    expect(sources.verify).not.toContain("scope: 'profile'");
});
