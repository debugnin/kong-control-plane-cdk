#!/usr/bin/env node

import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as fs from 'fs';
import * as path from 'path';
import { KongNetworkStack } from '../lib/kong-network-stack';
import { KongDatabaseStack } from '../lib/kong-database-stack';
import { KongControlPlaneStack } from '../lib/kong-control-plane-stack';

const app = new cdk.App();

// Environment examples: dev, qa, uat, prd
const environment = app.node.tryGetContext('environment') || process.env.ENVIRONMENT;
if (!environment) {
    throw new Error('ENVIRONMENT is required (examples: dev, qa, uat, prd)');
}

// Load environment-specific configuration file
let config: Record<string, any> = {};
const configPath = path.join(__dirname, '..', 'config', `${environment}.json`);
if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    console.log(`✓ Loaded configuration from config/${environment}.json`);
} else {
    console.log(
        `⚠ No config file found at config/${environment}.json, using CDK context and environment variables`
    );
}

/**
 * Get configuration value with precedence:
 * 1. config/{environment}.json
 * 2. cdk.context.json / --context (app.node.tryGetContext)
 * 3. Environment variables
 */
function getConfig(key: string, envVar: string): any {
    return config[key] ?? app.node.tryGetContext(key) ?? process.env[envVar];
}

const str = (key: string, envVar: string): string | undefined =>
    getConfig(key, envVar) || undefined;

const num = (key: string, envVar: string, fallback?: number): number | undefined => {
    const v = getConfig(key, envVar);
    return v === undefined || v === '' ? fallback : Number(v);
};

const bool = (key: string, envVar: string, fallback: boolean): boolean => {
    const v = getConfig(key, envVar);
    return v === undefined || v === '' ? fallback : String(v) === 'true';
};

const list = (key: string, envVar: string): string[] =>
    String(getConfig(key, envVar) || '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

const required = (key: string, envVar: string): string => {
    const v = str(key, envVar);
    if (!v) {
        throw new Error(`${envVar} (config key "${key}") is required`);
    }
    return v;
};

const env = {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
};

const qualifier = str('qualifier', 'CDK_QUALIFIER');
const synthesizer = qualifier
    ? new cdk.DefaultStackSynthesizer({ qualifier })
    : undefined;
const common = { env, ...(synthesizer && { synthesizer }) };

// 1. Network -------------------------------------------------------------------------
const networkStack = new KongNetworkStack(app, `kong-cp-network-stack-${environment}`, {
    ...common,
    environment,
    vpc: {
        vpcCidr: str('vpcCidr', 'VPC_CIDR'),
        maxAzs: num('vpcMaxAzs', 'VPC_MAX_AZS', 2),
        natGateways: num('vpcNatGateways', 'VPC_NAT_GATEWAYS', 1),
        enableFlowLogs: bool('vpcEnableFlowLogs', 'VPC_ENABLE_FLOW_LOGS', true),
        enableVpcEndpoints: bool('vpcEnableEndpoints', 'VPC_ENABLE_ENDPOINTS', true),
        transitGatewayId: str('transitGatewayId', 'TRANSIT_GATEWAY_ID'),
        transitGatewayRoutes: list('transitGatewayRoutes', 'TRANSIT_GATEWAY_ROUTES'),
    },
});

// 2. Database + backup (stateful) ------------------------------------------------------
const databaseStack = new KongDatabaseStack(
    app,
    `kong-cp-database-stack-${environment}`,
    {
        ...common,
        environment,
        vpc: networkStack.vpcConstruct.vpc,
        terminationProtection: bool(
            'dbDeletionProtection',
            'DB_DELETION_PROTECTION',
            true
        ),
        aurora: {
            engineVersion: str('dbEngineVersion', 'DB_ENGINE_VERSION'),
            minCapacityAcu: num('dbMinCapacityAcu', 'DB_MIN_CAPACITY_ACU'),
            maxCapacityAcu: num('dbMaxCapacityAcu', 'DB_MAX_CAPACITY_ACU'),
            readerCount: num('dbReaderCount', 'DB_READER_COUNT'),
            backupRetentionDays: num('dbBackupRetentionDays', 'DB_BACKUP_RETENTION_DAYS'),
            preferredBackupWindow: str(
                'dbPreferredBackupWindow',
                'DB_PREFERRED_BACKUP_WINDOW'
            ),
            preferredMaintenanceWindow: str(
                'dbPreferredMaintenanceWindow',
                'DB_PREFERRED_MAINTENANCE_WINDOW'
            ),
            deletionProtection: bool(
                'dbDeletionProtection',
                'DB_DELETION_PROTECTION',
                true
            ),
            snapshotIdentifier: str('dbSnapshotIdentifier', 'DB_SNAPSHOT_IDENTIFIER'),
        },
        backup: {
            enabled: bool('backupEnabled', 'BACKUP_ENABLED', true),
            intervalHours: num('backupIntervalHours', 'BACKUP_INTERVAL_HOURS'),
            retentionDays: num('backupRetentionDays', 'BACKUP_RETENTION_DAYS'),
            weeklyRetentionDays: num(
                'backupWeeklyRetentionDays',
                'BACKUP_WEEKLY_RETENTION_DAYS'
            ),
            monthlyRetentionDays: num(
                'backupMonthlyRetentionDays',
                'BACKUP_MONTHLY_RETENTION_DAYS'
            ),
            startHourUtc: num('backupStartHourUtc', 'BACKUP_START_HOUR_UTC'),
            copyToVaultArn: str('backupCopyToVaultArn', 'BACKUP_COPY_TO_VAULT_ARN'),
        },
    }
);
databaseStack.addDependency(networkStack);

// 3. Control plane (stateless) ---------------------------------------------------------
const logRetention = num('logRetentionDays', 'LOG_RETENTION_DAYS');
const controlPlaneStack = new KongControlPlaneStack(
    app,
    `kong-cp-service-stack-${environment}`,
    {
        ...common,
        environment,
        vpc: networkStack.vpcConstruct.vpc,
        database: {
            cluster: databaseStack.aurora.cluster,
            securityGroup: databaseStack.aurora.securityGroup,
            databaseName: databaseStack.aurora.databaseName,
            caBundlePem: (() => {
                const region = env.region ?? process.env.AWS_REGION ?? 'ap-southeast-2';
                const caPath = path.join(
                    __dirname,
                    '..',
                    str('dbCaBundlePath', 'DB_CA_BUNDLE_PATH') ??
                        `certs/rds-ca-${region}.pem`
                );
                if (!fs.existsSync(caPath)) {
                    throw new Error(
                        `RDS CA bundle not found at ${caPath}. Run ./scripts/fetch-rds-ca.sh ${region} ` +
                            `or set dbCaBundlePath / DB_CA_BUNDLE_PATH.`
                    );
                }
                return fs.readFileSync(caPath, 'utf8');
            })(),
            encryptionKey: databaseStack.aurora.encryptionKey,
            adminSecret: databaseStack.adminSecret,
            sessionSecret: databaseStack.sessionSecret,
        },
        controlPlane: {
            imageUri: required('kongImageUri', 'KONG_IMAGE_URI'),
            licenseSecretArn: required('kongLicenseSecretArn', 'KONG_LICENSE_SECRET_ARN'),
            clusterCertSecretArn: required(
                'clusterCertSecretArn',
                'CLUSTER_CERT_SECRET_ARN'
            ),
            cpu: num('cpCpu', 'CP_CPU'),
            memoryMiB: num('cpMemory', 'CP_MEMORY'),
            replicas: num('cpReplicas', 'CP_REPLICAS'),
            logLevel: str('cpLogLevel', 'CP_LOG_LEVEL'),
            logRetentionDays: logRetention as logs.RetentionDays | undefined,
            dataPlaneCidrs: list('dataPlaneCidrs', 'DATA_PLANE_CIDRS'),
            clusterDomain: str('clusterDomain', 'CLUSTER_DOMAIN'),
        },
        certificate: {
            existingArn: str('albCertificateArn', 'ALB_CERTIFICATE_ARN'),
            domainName: str('albDomain', 'ALB_DOMAIN'),
            subjectAlternativeNames: list(
                'albSubjectAlternativeNames',
                'ALB_SUBJECT_ALTERNATIVE_NAMES'
            ),
            hostedZoneId: str('albHostedZoneId', 'ALB_HOSTED_ZONE_ID'),
            hostedZoneName: str('albHostedZoneName', 'ALB_HOSTED_ZONE_NAME'),
        },
        alb: {
            allowedCidrs: list('albAllowedCidrs', 'ALB_ALLOWED_CIDRS'),
            internetFacing: bool('albInternetFacing', 'ALB_INTERNET_FACING', false),
            enableAccessLogs: bool('albEnableAccessLogs', 'ALB_ENABLE_ACCESS_LOGS', true),
        },
        waf: {
            enabled: bool('wafEnabled', 'WAF_ENABLED', true),
            rateLimitPerMinute: num('wafRateLimit', 'WAF_RATE_LIMIT', 2000),
            allowedCidrs: list('wafAllowedCidrs', 'WAF_ALLOWED_CIDRS'),
            enableCidrRestriction: bool(
                'wafEnableCidrRestriction',
                'WAF_ENABLE_CIDR_RESTRICTION',
                false
            ),
        },
        logging: {
            enabled: bool('loggingEnabled', 'LOGGING_ENABLED', true),
            centralDestinationArn: str(
                'loggingCentralDestinationArn',
                'LOGGING_CENTRAL_DESTINATION_ARN'
            ),
            filterPattern: str('loggingFilterPattern', 'LOGGING_FILTER_PATTERN'),
        },
    }
);
controlPlaneStack.addDependency(databaseStack);
