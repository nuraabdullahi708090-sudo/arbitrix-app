'use strict';

/**
 * Client IP identification and proxy trust.
 *
 * WHY: several security controls key off the caller's IP address - the login and
 * registration rate limiters, the forgot-password limiter, and audit logs. The
 * previous helper read the FIRST entry of `X-Forwarded-For`, which is supplied by
 * the client whenever a proxy appends rather than replaces the header. A caller
 * could therefore rotate that header and appear to come from a new address on
 * every request.
 *
 * RULE: this module never parses `X-Forwarded-For` itself. It uses `req.ip`,
 * which Express derives ONLY from the socket address plus the number of trusted
 * proxies configured on the app (`app.set('trust proxy', ...)`). When no proxy is
 * trusted (the default), `req.ip` is the socket peer and cannot be spoofed.
 *
 * DEPLOYMENT ASSUMPTION: the repository does not contain a recorded proxy
 * topology (no render.yaml, no edge configuration), so the number of proxies
 * cannot be proven from source. It is therefore EXPLICIT configuration:
 *
 *   TRUST_PROXY        - Express-compatible trust list: comma separated IPv4/IPv6
 *                        CIDRs or the keywords loopback / linklocal / uniquelocal.
 *                        Preferred: it does not depend on hop counting.
 *   TRUST_PROXY_HOPS   - integer 1..MAX_HOPS: trust that many proxies immediately
 *                        in front of the app (e.g. 2 for Cloudflare -> Render).
 *   (neither)          - trust NOTHING. Safe default; the IP limiter then sees the
 *                        proxy address and degrades to a coarse shared limit, but a
 *                        direct caller can never spoof an identity.
 *
 * A blanket `true` / `*` / `all` is REFUSED: it would trust a client-supplied
 * chain and reintroduce the bypass. See docs/security/ADMIN_PROVISIONING.md.
 */

const MAX_TRUST_HOPS = 10;

// Accept only the shapes Express itself understands, so a typo cannot silently
// disable the setting.
const TRUST_KEYWORDS = ['loopback', 'linklocal', 'uniquelocal'];
const IPV4_CIDR = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;
const IPV6_CIDR = /^[0-9a-f:]+(\/\d{1,3})?$/i;

function isTrustToken(token) {
  if (!token) return false;
  const value = token.trim().toLowerCase();
  if (TRUST_KEYWORDS.indexOf(value) !== -1) return true;
  if (!IPV4_CIDR.test(value) && !IPV6_CIDR.test(value)) return false;
  const parts = value.split('/');
  if (parts.length === 2) {
    const bits = parseInt(parts[1], 10);
    if (!Number.isFinite(bits) || bits < 0 || bits > 128) return false;
  }
  return true;
}

/**
 * Resolve the Express `trust proxy` setting from the environment.
 *
 * @param {object} env
 * @returns {{mode: 'none'|'list'|'hops', value: false|string|number, source: string, detail: string, warning?: string}}
 */
function resolveProxyTrust(env) {
  const source = env || {};
  const rawList = source.TRUST_PROXY;
  const rawHops = source.TRUST_PROXY_HOPS;

  const listProvided = rawList != null && String(rawList).trim() !== '';
  if (listProvided) {
    const tokens = String(rawList).split(',').map(function (t) { return t.trim(); }).filter(Boolean);

    if (tokens.length === 0) {
      return { mode: 'none', value: false, source: 'TRUST_PROXY', detail: 'empty list' };
    }
    // Refuse a blanket trust: it lets the caller supply the chain.
    const blanket = tokens.some(function (t) {
      const v = t.toLowerCase();
      return v === 'true' || v === '*' || v === 'all' || v === '0.0.0.0/0' || v === '::/0';
    });
    if (blanket) {
      return {
        mode: 'none',
        value: false,
        source: 'TRUST_PROXY',
        detail: 'blanket trust refused',
        warning: 'TRUST_PROXY must list the proxy CIDRs (or use TRUST_PROXY_HOPS); blanket trust is ignored'
      };
    }
    const invalid = tokens.filter(function (t) { return !isTrustToken(t); });
    if (invalid.length > 0) {
      return {
        mode: 'none',
        value: false,
        source: 'TRUST_PROXY',
        detail: 'invalid entries',
        warning: 'TRUST_PROXY contains unsupported entries (' + invalid.join(', ') + '); proxy trust disabled'
      };
    }
    return {
      mode: 'list',
      value: tokens.join(', '),
      source: 'TRUST_PROXY',
      detail: tokens.join(', ')
    };
  }

  const hopsProvided = rawHops != null && String(rawHops).trim() !== '';
  if (hopsProvided) {
    // Strict integer: parseInt('2.5') would silently accept 2.
    const raw = String(rawHops).trim();
    const hops = /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN;
    if (!Number.isFinite(hops) || hops < 1 || hops > MAX_TRUST_HOPS) {
      return {
        mode: 'none',
        value: false,
        source: 'TRUST_PROXY_HOPS',
        detail: 'invalid hop count',
        warning: 'TRUST_PROXY_HOPS must be an integer between 1 and ' + MAX_TRUST_HOPS +
          '; proxy trust disabled (the IP limiter will see the proxy address)'
      };
    }
    return { mode: 'hops', value: hops, source: 'TRUST_PROXY_HOPS', detail: String(hops) };
  }

  return { mode: 'none', value: false, source: 'default', detail: 'no proxy trusted' };
}

/**
 * Normalise an address for use as a rate-limit key and in audit logs:
 * strip an IPv4-mapped IPv6 prefix and any :port suffix, trim, lowercase.
 */
function normalizeIp(value) {
  if (value == null) return '';
  let ip = String(value).trim();
  if (!ip) return '';

  // "[2001:db8::1]:443" / "1.2.3.4:5678"
  const bracketed = ip.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) ip = bracketed[1];
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.split(':')[0];

  // IPv4-mapped IPv6: ::ffff:1.2.3.4
  const mapped = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) ip = mapped[1];

  return ip.toLowerCase();
}

/**
 * The client IP the server actually trusts. Never reads a header.
 *
 * @param {object} req - Express request (after `trust proxy` is configured)
 * @returns {string} a normalised address, or 'unknown'
 */
function getClientIp(req) {
  try {
    if (!req) return 'unknown';
    const raw = req.ip || (req.socket && req.socket.remoteAddress) || '';
    return normalizeIp(raw) || 'unknown';
  } catch (e) {
    return 'unknown';
  }
}

module.exports = {
  MAX_TRUST_HOPS: MAX_TRUST_HOPS,
  isTrustToken: isTrustToken,
  resolveProxyTrust: resolveProxyTrust,
  normalizeIp: normalizeIp,
  getClientIp: getClientIp
};
