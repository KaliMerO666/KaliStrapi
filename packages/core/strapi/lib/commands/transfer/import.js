'use strict';

const {
  createLocalFileSourceProvider,
  createLocalStrapiDestinationProvider,
  createTransferEngine,
  DEFAULT_VERSION_STRATEGY,
  DEFAULT_SCHEMA_STRATEGY,
  DEFAULT_CONFLICT_STRATEGY,
  // TODO: we need to solve this issue with typescript modules
  // eslint-disable-next-line import/no-unresolved, node/no-missing-require
} = require('@strapi/data-transfer');
const { isObject } = require('lodash/fp');
const path = require('path');

const strapi = require('../../index');
const { buildTransferTable, DEFAULT_IGNORED_CONTENT_TYPES } = require('./utils');

/**
 * @typedef {import('@strapi/data-transfer').ILocalFileSourceProviderOptions} ILocalFileSourceProviderOptions
 */

const logger = console;

module.exports = async (opts) => {
  // validate inputs from Commander
  if (!isObject(opts)) {
    logger.error('Could not parse arguments');
    process.exit(1);
  }

  /**
   * From strapi backup file
   */
  const sourceOptions = getLocalFileSourceOptions(opts);

  const source = createLocalFileSourceProvider(sourceOptions);

  /**
   * To local Strapi instance
   */
  const strapiInstance = await strapi(await strapi.compile()).load();

  const destinationOptions = {
    async getStrapi() {
      return strapiInstance;
    },
    strategy: opts.conflictStrategy || DEFAULT_CONFLICT_STRATEGY,
    restore: {
      entities: { exclude: DEFAULT_IGNORED_CONTENT_TYPES },
    },
  };
  const destination = createLocalStrapiDestinationProvider(destinationOptions);

  /**
   * Configure and run the transfer engine
   */
  const engineOptions = {
    versionStrategy: opts.versionStrategy || DEFAULT_VERSION_STRATEGY,
    schemaStrategy: opts.schemaStrategy || DEFAULT_SCHEMA_STRATEGY,
    exclude: opts.exclude,
    rules: {
      links: [
        {
          filter(link) {
            return (
              !DEFAULT_IGNORED_CONTENT_TYPES.includes(link.left.type) &&
              !DEFAULT_IGNORED_CONTENT_TYPES.includes(link.right.type)
            );
          },
        },
      ],
      entities: [
        {
          filter: (entity) => !DEFAULT_IGNORED_CONTENT_TYPES.includes(entity.type),
        },
      ],
    },
  };
  const engine = createTransferEngine(source, destination, engineOptions);

  let transferExitCode;
  logger.info('Starting import...');

  const progress = engine.progress.stream;
  const telemetryPayload = (/* payload */) => {
    return {
      eventProperties: {
        source: engine.sourceProvider.name,
        destination: engine.destinationProvider.name,
      },
    };
  };

  progress.on('transfer::start', async (payload) => {
    await strapiInstance.telemetry.send('didDEITSProcessStart', telemetryPayload(payload));
  });

  progress.on('transfer::finish', async (payload) => {
    await strapiInstance.telemetry.send('didDEITSProcessFinish', telemetryPayload(payload));
    transferExitCode = 0;
  });

  progress.on('transfer::error', async (payload) => {
    await strapiInstance.telemetry.send('didDEITSProcessFail', telemetryPayload(payload));
    transferExitCode = 1;
  });

  try {
    const results = await engine.transfer();
    const table = buildTransferTable(results.engine);
    logger.info(table.toString());

    logger.info('Import process has been completed successfully!');
  } catch (e) {
    logger.error('Import process failed unexpectedly:');
    logger.error(e);
    process.exit(1);
  }

  /*
   * We need to wait for the telemetry to finish before exiting the process.
   * The order of execution for the overall import function is:
   * - create providers and engine
   * - create progress callbacks
   * - await the engine transfer
   *   - having async calls inside, it allows the transfer::start to process
   * - the code block including the table printing executes
   * - *** any async code (for example, the fs.pathExists) after engine.transfer will execute next tick, therefore:
   * - the progress callbacks execute
   *
   * Because of that, we can't exit the process in the progress callbacks and instead have to wait for them to tell us it's safe to exit
   */
  const waitForExitCode = async (maxWait) => {
    const startTime = Date.now();
    while (Date.now() - startTime < maxWait) {
      if (transferExitCode !== undefined) {
        process.exit(transferExitCode);
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
    }
    process.exit(0);
  };
  waitForExitCode(5000);
};

/**
 * Infer local file source provider options based on a given filename
 *
 * @param {{ file: string; key?: string }} opts
 *
 * @return {ILocalFileSourceProviderOptions}
 */
const getLocalFileSourceOptions = (opts) => {
  /**
   * @type {ILocalFileSourceProviderOptions}
   */
  const options = {
    file: { path: opts.file },
    compression: { enabled: false },
    encryption: { enabled: false },
  };

  const { extname, parse } = path;

  let file = options.file.path;

  if (extname(file) === '.enc') {
    file = parse(file).name;
    options.encryption = { enabled: true, key: opts.key };
  }

  if (extname(file) === '.gz') {
    file = parse(file).name;
    options.compression = { enabled: true };
  }

  return options;
};