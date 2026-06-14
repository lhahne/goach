import { exportJWK, generateKeyPair, SignJWT, createRemoteJWKSet, jwtVerify } from "jose";
const team = "x.cloudflareaccess.com";
const issuer = `https://${team}`;
const AUD = "test-aud", KID = "k1";
const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
const jwk = await exportJWK(publicKey); jwk.kid = KID; jwk.alg = "RS256"; jwk.use = "sig";
globalThis.fetch = async (input) => {
  if (String(input).includes("/cdn-cgi/access/certs")) return Response.json({ keys: [jwk] });
  throw new Error("unexpected " + input);
};
const token = await new SignJWT({ email: "o@e.com" })
  .setProtectedHeader({ alg: "RS256", kid: KID }).setIssuedAt()
  .setIssuer(issuer).setAudience(AUD).setExpirationTime("2h").sign(privateKey);
const JWKS = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
try {
  const { payload } = await jwtVerify(token, JWKS, { issuer, audience: AUD });
  console.log("OK", payload.email);
} catch (e) { console.log("ERR", e.code, e.message); }
