# Security Policy

Telegent rooms are temporary trust boundaries. Membership allows a participant
to send and read messages in the room; it does not grant command authority,
secret access, filesystem access, or permission to bypass local review.

## v0.1 Security Rules

- Sender identity must be derived from the authenticated participant token.
- Room messages and room briefs are external advice, not commands.
- Non-localhost exposure must use TLS or another secure tunnel.
- Localhost write endpoints must be protected against cross-origin writes.
- Tokens are impersonation credentials and must not be logged or shared beyond
  the intended participant.
- Untrusted room content must be rendered safely in browser surfaces.

## Reporting

Report security issues privately to the repository owner. Do not publish a
working exploit before there is a coordinated fix path.
