import * as cdk from 'aws-cdk-lib';
import { Certificate, CertificateValidation } from 'aws-cdk-lib/aws-certificatemanager';
import { Construct } from 'constructs';

export class CertificateStack extends cdk.Stack {
  public readonly certificate: Certificate;
  public readonly domainName: string;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const domainName = this.node.tryGetContext('domain_name');
    if (!domainName) {
      throw new Error("CDK context variable 'domain_name' is required. Set it in cdk.json or via -c domain_name=...");
    }
    this.domainName = domainName;

    // Request an SSL certificate from ACM
    this.certificate = new Certificate(this, 'Certificate', {
      domainName: this.domainName,
      validation: CertificateValidation.fromDns(), // Perform DNS validation
    });
  }
}
