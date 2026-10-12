// Apply this release's guard packaging to the tap formula, idempotently.
import { readFileSync, writeFileSync } from 'node:fs';
const formula = process.argv[2];
const fragment = readFileSync(new URL('../packaging/resource-guard-install.rb', import.meta.url), 'utf8');
let text = readFileSync(formula, 'utf8');
text = text.replace(/\n*    # BEGIN cmux-resource-guard packaging[\s\S]*?    # END cmux-resource-guard packaging\n*/g, '\n');
const anchor = '    libexec.install "dist", "node_modules", "package.json"';
if (!text.includes(anchor)) throw new Error('formula install anchor changed; refusing partial packaging');
if (!/^  depends_on "jq"$/m.test(text)) text = text.replace('  def install\n', '  depends_on "jq"\n\n  def install\n');
text = text.replace(anchor, anchor + '\n\n' + fragment);
writeFileSync(formula, text);
