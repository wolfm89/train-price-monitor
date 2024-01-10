import * as cdk from 'aws-cdk-lib';
import { Certificate, CertificateValidation } from 'aws-cdk-lib/aws-certificatemanager';
import { Construct } from 'constructs';

export class CertificateStack extends cdk.Stack {
  public readonly certificate: Certificate;
  public readonly domainName: string = 'tpm.wolfgangmoser.eu';

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Request an SSL certificate from ACM
    this.certificate = new Certificate(this, 'Certificate', {
      domainName: this.domainName,
      validation: CertificateValidation.fromDns(), // Perform DNS validation
    });
  }
}
