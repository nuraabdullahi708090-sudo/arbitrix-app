#!/usr/bin/env node
'use strict';

/**
 * Generate the identity assets from BRAND.candidateIdentity.
 *
 * The palette, the monogram and the tagline live in one object, so the logo,
 * the wordmark, the favicon and the social card cannot drift apart - and a
 * future rename regenerates all four instead of hunting for an old PNG.
 *
 * USAGE
 *   node scripts/build-brand-assets.js            # write public/brand/*
 *
 * The output is plain SVG with no external references, no embedded fonts and no
 * raster data, so it renders identically in a browser, in an e-mail client and
 * as a favicon.
 */

const fs = require('fs');
const path = require('path');
const { BRAND } = require('../services/brand');

const OUT = path.join(__dirname, '..', 'public', 'brand');

function assets() {
  const id = BRAND.candidateIdentity;
  const p = id.palette;
  const mark = id.mark;
  const name = id.name;
  const tagline = BRAND.tagline;

  // A gradient is the only decoration: it reads as "technology" at 16px and
  // still looks deliberate at 1200px, without adding a second shape language.
  const defs = '<defs><linearGradient id="kx" x1="0" y1="0" x2="1" y2="1">'
    + '<stop offset="0" stop-color="' + p.accent + '"/>'
    + '<stop offset="1" stop-color="' + p.secondary + '"/></linearGradient></defs>';

  // The symbol is drawn, not typed: three converging flows and a node. A webfont
  // glyph would depend on the renderer and would not scale to a favicon.
  const sym = id.symbol;
  const legs = sym.legs.map(function (d) {
    return '<path d="' + d + '" fill="none" stroke="url(#kx)" stroke-width="' + sym.strokeWidth
      + '" stroke-linecap="round" stroke-linejoin="round"/>';
  }).join('');

  const markSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + sym.viewBox + '" role="img" aria-label="' + name + '">'
    + defs
    + '<rect width="512" height="512" rx="112" fill="' + p.surface + '"/>'
    + '<rect x="1" y="1" width="510" height="510" rx="111" fill="none" stroke="' + p.accent + '" stroke-opacity="0.35" stroke-width="2"/>'
    + legs
    + '<path d="' + sym.node + '" fill="' + p.textPrimary + '"/>'
    + '</svg>';

  const faviconSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + sym.viewBox + '" role="img" aria-label="' + name + '">'
    + defs
    + '<rect width="512" height="512" rx="112" fill="' + p.surface + '"/>'
    + legs
    + '<path d="' + sym.node + '" fill="' + p.textPrimary + '"/>'
    + '</svg>';

  const wordmarkSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 160" role="img" aria-label="' + name + '">'
    + defs
    + '<rect x="8" y="20" width="120" height="120" rx="28" fill="' + p.surface + '"/>'
    + '<g transform="translate(8 20) scale(0.234375)">' + legs + '<path d="' + sym.node + '" fill="' + p.textPrimary + '"/></g>'
    + '<text x="152" y="96" font-family="Arial, Helvetica, sans-serif" font-size="64" font-weight="800" fill="' + p.textPrimary + '">' + name + '</text>'
    + '<text x="154" y="130" font-family="Arial, Helvetica, sans-serif" font-size="18" font-weight="500" letter-spacing="1.2" fill="' + p.textSecondary + '">' + tagline.toUpperCase() + '</text>'
    + '</svg>';

  const socialSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" role="img" aria-label="' + name + '">'
    + defs
    + '<rect width="1200" height="630" fill="' + p.surface + '"/>'
    + '<circle cx="1050" cy="120" r="220" fill="' + p.accent + '" fill-opacity="0.08"/>'
    + '<circle cx="120" cy="560" r="180" fill="' + p.secondary + '" fill-opacity="0.06"/>'
    + '<text x="600" y="318" font-family="Arial, Helvetica, sans-serif" font-size="128" font-weight="900" text-anchor="middle" fill="url(#kx)">' + name + '</text>'
    + '<text x="600" y="400" font-family="Arial, Helvetica, sans-serif" font-size="40" font-weight="400" text-anchor="middle" fill="' + p.textSecondary + '">' + tagline + '</text>'
    + '</svg>';

  return [
    ['kalderix-mark.svg', markSvg],
    ['kalderix-favicon.svg', faviconSvg],
    ['kalderix-wordmark.svg', wordmarkSvg],
    ['kalderix-social.svg', socialSvg]
  ];
}

if (require.main === module) {
  fs.mkdirSync(OUT, { recursive: true });
  for (const [file, svg] of assets()) {
    fs.writeFileSync(path.join(OUT, file), svg + '\n');
    console.log('  wrote public/brand/' + file + '  (' + Buffer.byteLength(svg) + ' bytes)');
  }
  console.log('');
  console.log('These are the CANDIDATE assets. Nothing references them yet: the app');
  console.log('generates its icons from BRAND, so approving the rename switches the');
  console.log('identity without pointing the page at these files.');
}

module.exports = { assets };
