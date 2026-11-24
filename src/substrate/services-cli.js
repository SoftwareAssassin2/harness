// The bash commands' way into a project's sandbox declaration (ASS-534,
// services.js) and the image build's Dockerfile (dockerfile.js):
//
//   node services-cli.js read <sandbox folder>
//       the folder's services.yaml checked and normalized, one JSON line;
//       `null` when the folder has no services.yaml; exits 1, every problem
//       named on stderr, when it is wrong
//   node services-cli.js dockerfile <sandbox folder> <arch> <context JSON>
//       the sandbox image's Dockerfile (dockerfile.js renderDockerfile), the
//       context { project, repositories, contexts: { <service>: true } } —
//       contexts the services whose image is handed to the build as an OCI
//       layout (an image of the project's registry upstream, fetched through
//       its zot), the rest named in a FROM
import { readServices, normalizeServices } from './services.js';
import { renderDockerfile } from './dockerfile.js';

const [command, folder, arch, context] = process.argv.slice(2);
try {
  if (command === 'read') {
    process.stdout.write(`${JSON.stringify(readServices(folder))}\n`);
  } else if (command === 'dockerfile') {
    const declaration = readServices(folder) ?? normalizeServices({ architectures: [arch], services: [] });
    process.stdout.write(renderDockerfile({ ...JSON.parse(context), arch, declaration }));
  } else {
    throw new Error('usage: services-cli.js read <folder> | dockerfile <folder> <arch> <context JSON>');
  }
} catch (e) {
  process.stderr.write(`${e.message}\n`);
  process.exit(1);
}
