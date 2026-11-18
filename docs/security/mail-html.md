# Reading untrusted HTML mail

The reader uses DOMPurify with explicit HTML tag and attribute allowlists. Scripts,
forms, embedded documents, SVG, sender stylesheets, srcset and navigation attributes
are removed. A small inline CSS allowlist preserves typography and table layout;
CSS URLs, escapes, positioning and functions other than numeric color functions
are rejected.

The resulting document runs in an opaque-origin iframe with an empty sandbox.
A CSP before all content blocks scripts, connections, forms, frames, fonts and other
resources. Only application-created raster CID data URLs can load by default. Mail links are
inert in the iframe; validated absolute HTTP(S) and mailto links are listed in the
parent with noreferrer/noopener and require a user click.

Remote HTTP(S) images require an explicit per-message action. Consent is in memory,
resets when changing messages, and can be revoked. It permits image requests (which
can reveal the reader's IP and reading time), never remote CSS, fonts or scripts.
No sender-provided data/blob URLs or relative resource URLs are accepted.

HTML above 1,048,576 UTF-16 code units is not parsed. CID resolution considers at
most 64 references and 256 attachment records, accepts PNG/JPEG/GIF/WebP only, and
streams at most 10 MiB in aggregate within 30 seconds. At most 256 image
elements may load, and embedded data URLs have a 14 MiB output budget so repeated
CID references cannot amplify document size. Downloads are authenticated in the parent,
cancelled on message change, and converted to raster data URLs (sender-provided data URLs are removed). Failures leave
the text readable. Existing attachment retrieval limits also apply.

Run `npm run test:browser` after `npx playwright install chromium`. Tests mount the
real reader component with synthetic mail and a loopback-only HTTP service. They
exercise script/DOM isolation, navigation/popups, forms, CSS/resource filtering,
CID display, ordinary layout, remote-image consent/reset and oversized HTML.
