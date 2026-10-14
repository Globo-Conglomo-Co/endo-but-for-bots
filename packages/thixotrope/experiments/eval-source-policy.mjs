import { ModuleSource } from '@endo/module-source';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const prepareInstallSource = source => {
  const moduleSource = /\bexport\s+(?:const|function)\s+make\b/.test(source)
    ? source
    : /\b(?:const|function)\s+make\b/.test(source)
      ? `${source}\nexport { make };\n`
      : `export const make = (${source});\n`;
  // Parse the exact text the host would bundle. This records all static imports,
  // reexports, dynamic imports, and import.meta without evaluating guest code.
  const record = new ModuleSource(moduleSource);
  if (
    record.imports.length > 0 ||
    record.reexports.length > 0 ||
    // eslint-disable-next-line no-underscore-dangle, dot-notation -- fixed ModuleSource parser metadata keys
    record.__needsImport__ ||
    // eslint-disable-next-line no-underscore-dangle, dot-notation -- fixed ModuleSource parser metadata keys
    record.__needsImportMeta__
  ) {
    throw Error('Guest installation source may not import modules or use import.meta');
  }
  if (record.exports.length !== 1 || record.exports[0] !== 'make') {
    throw Error('Guest installation source must export only make');
  }
  return moduleSource;
};

export const installGuestSource = async ({
  name, source, grants, sourceUrl, writeFile, bundle, install, removeFile,
}) => {
  // Refuse before creating a host file or invoking the host bundler.
  const moduleSource = prepareInstallSource(source);
  const sourcePath = fileURLToPath(new URL(`./eval-${randomUUID()}.mjs`, sourceUrl));
  try {
    await writeFile(sourcePath, moduleSource, { mode: 0o600 });
    const { bundle: bundled } = await bundle(sourcePath);
    return await install(name, bundled, grants);
  } finally {
    await removeFile(sourcePath, { force: true });
  }
};
