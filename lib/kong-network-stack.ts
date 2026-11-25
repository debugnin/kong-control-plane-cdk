import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { VpcConstruct } from './constructs/vpc-construct';

export interface KongNetworkStackProps extends cdk.StackProps {
    environment: string; // Environment: dev, qa, uat, prd
    vpc?: {
        vpcCidr?: string;
        maxAzs?: number;
        natGateways?: number;
        enableFlowLogs?: boolean;
        enableVpcEndpoints?: boolean;
        transitGatewayId?: string;
        transitGatewayRoutes?: string[];
    };
}

/** VPC, flow logs, VPC endpoints and optional Transit Gateway attachment. */
export class KongNetworkStack extends cdk.Stack {
    public readonly vpcConstruct: VpcConstruct;

    constructor(scope: Construct, id: string, props: KongNetworkStackProps) {
        super(scope, id, props);

        this.vpcConstruct = new VpcConstruct(this, 'VpcConstruct', {
            environment: props.environment,
            ...props.vpc,
        });

        new cdk.CfnOutput(this, 'VpcId', {
            value: this.vpcConstruct.vpc.vpcId,
            description: 'VPC ID',
        });
    }
}
