/** Extension point for an external OIDC/JWT identity adapter. */
export interface ProviderIdentityPort {
  authenticate(authorization: string | undefined): Promise<{providerId:string}>;
}
