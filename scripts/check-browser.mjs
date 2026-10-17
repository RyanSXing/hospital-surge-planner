/** Repeatable browser acceptance entrypoint. Requires make setup and a local dev server. */
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const cwd=fileURLToPath(new URL('../apps/web/',import.meta.url));
const result=spawnSync(process.execPath,['node_modules/@playwright/test/cli.js','test',...process.argv.slice(2)],{cwd,stdio:'inherit',env:process.env});
process.exit(result.status??1);
