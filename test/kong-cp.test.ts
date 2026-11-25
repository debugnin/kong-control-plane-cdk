import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { KongNetworkStack } from '../lib/kong-network-stack';
import { KongDatabaseStack } from '../lib/kong-database-stack';
import { KongControlPlaneStack } from '../lib/kong-control-plane-stack';

const env = { account: '111122223333', region: 'ap-southeast-2' };
const secretArn = (n: string) =>
    `arn:aws:secretsmanager:ap-southeast-2:111122223333:secret:${n}-AbCdEf`;

function build(opts: { backup?: any; aurora?: any } = {}) {
    const app = new cdk.App();
    const network = new KongNetworkStack(app, 'net', { env, environment: 'dev' });
    const db = new KongDatabaseStack(app, 'db', {
        env,
        environment: 'dev',
        vpc: network.vpcConstruct.vpc,
        ...opts,
    });
    const cp = new KongControlPlaneStack(app, 'cp', {
        env,
        environment: 'dev',
        vpc: network.vpcConstruct.vpc,
        database: {
            cluster: db.aurora.cluster,
            securityGroup: db.aurora.securityGroup,
            databaseName: db.aurora.databaseName,
            encryptionKey: db.aurora.encryptionKey,
            adminSecret: db.adminSecret,
            sessionSecret: db.sessionSecret,
        },
        controlPlane: {
            imageUri: 'kong/kong-gateway:3.15',
            licenseSecretArn: secretArn('license'),
            clusterCertSecretArn: secretArn('cluster'),
        },
        certificate: {
            existingArn:
                'arn:aws:acm:ap-southeast-2:111122223333:certificate/00000000-0000-0000-0000-000000000000',
        },
        alb: {},
    });
    return {
        db: Template.fromStack(db),
        cp: Template.fromStack(cp),
    };
}

describe('Aurora Serverless v2', () => {
    const { db } = build();

    test('PostgreSQL cluster with serverless v2 scaling and encryption', () => {
        db.hasResourceProperties('AWS::RDS::DBCluster', {
            Engine: 'aurora-postgresql',
            StorageEncrypted: true,
            DeletionProtection: true,
            ServerlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 4 },
        });
    });

    test('all instances are db.serverless', () => {
        const instances = db.findResources('AWS::RDS::DBInstance');
        expect(Object.keys(instances)).toHaveLength(2); // writer + 1 reader
        for (const i of Object.values(instances)) {
            expect((i as any).Properties.DBInstanceClass).toBe('db.serverless');
        }
    });
});

describe('AWS Backup', () => {
    test('plan with daily rule, vault and Aurora selection', () => {
        const { db } = build();
        db.resourceCountIs('AWS::Backup::BackupVault', 1);
        db.hasResourceProperties('AWS::Backup::BackupPlan', {
            BackupPlan: {
                BackupPlanRule: [
                    Match.objectLike({
                        RuleName: 'Daily',
                        Lifecycle: Match.objectLike({ DeleteAfterDays: 35 }),
                    }),
                ],
            },
        });
        db.hasResourceProperties('AWS::Backup::BackupSelection', {
            BackupSelection: Match.objectLike({ Resources: Match.anyValue() }),
        });
    });

    test('weekly and monthly rules are opt-in', () => {
        const { db } = build({
            backup: { weeklyRetentionDays: 90, monthlyRetentionDays: 365 },
        });
        const plan = Object.values(db.findResources('AWS::Backup::BackupPlan'))[0] as any;
        const names = plan.Properties.BackupPlan.BackupPlanRule.map(
            (r: any) => r.RuleName
        );
        expect(names).toEqual(['Daily', 'Weekly', 'Monthly']);
    });

    test('can be disabled', () => {
        const { db } = build({ backup: { enabled: false } });
        db.resourceCountIs('AWS::Backup::BackupPlan', 0);
    });
});

describe('Control plane service', () => {
    const { cp } = build();

    test('runs Kong as control_plane with no proxy listener', () => {
        const td = Object.values(cp.findResources('AWS::ECS::TaskDefinition'))[0] as any;
        const kong = td.Properties.ContainerDefinitions.find(
            (c: any) => c.Name === 'kong-cp'
        );
        const env = Object.fromEntries(
            kong.Environment.map((e: any) => [e.Name, e.Value])
        );
        expect(env.KONG_ROLE).toBe('control_plane');
        expect(env.KONG_PROXY_LISTEN).toBe('off');
        expect(env.KONG_DATABASE).toBe('postgres');
        expect(JSON.stringify(kong.Secrets)).toContain('KONG_LICENSE_DATA');
    });

    test('migrations bootstrap runs first and must succeed', () => {
        const td = Object.values(cp.findResources('AWS::ECS::TaskDefinition'))[0] as any;
        const names = td.Properties.ContainerDefinitions.map((c: any) => c.Name);
        expect(names).toEqual(expect.arrayContaining(['kong-migrations', 'kong-cp']));
        const mig = td.Properties.ContainerDefinitions.find(
            (c: any) => c.Name === 'kong-migrations'
        );
        expect(mig.Command).toEqual(['kong', 'migrations', 'bootstrap']);
        expect(mig.Essential).toBe(false);
    });

    test('ALB is internal; NLB exposes 8005 and 8006', () => {
        cp.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
            Type: 'application',
            Scheme: 'internal',
        });
        cp.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
            Port: 8005,
            Protocol: 'TCP',
        });
        cp.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
            Port: 8006,
            Protocol: 'TCP',
        });
    });

    test('contains no data plane resources', () => {
        const json = JSON.stringify(cp.toJSON());
        expect(json).not.toContain('konnect');
        expect(json).not.toContain('data_plane');
    });
});

describe('Restore from snapshot', () => {
    test('uses SnapshotIdentifier when dbSnapshotIdentifier is set', () => {
        const { db } = build({
            aurora: {
                snapshotIdentifier:
                    'arn:aws:rds:ap-southeast-2:111122223333:cluster-snapshot:awsbackup:job-1',
            },
        });
        db.hasResourceProperties('AWS::RDS::DBCluster', {
            SnapshotIdentifier: Match.stringLikeRegexp('awsbackup:job-1'),
        });
    });
});
