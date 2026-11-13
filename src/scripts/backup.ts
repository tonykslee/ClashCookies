import {
  createAgeEncryptor,
  createB2ObjectStore,
  createPgDumpRunner,
  loadBackupConfig,
  runBackup,
  sendBackupNotification,
} from "../backup/BackupService";

/** Runs the production backup command using only service-file and public-recipient configuration. */
async function main(): Promise<void> {
  const config = loadBackupConfig();
  await runBackup(config, {
    runDump: createPgDumpRunner(config),
    encryptDump: createAgeEncryptor(),
    objectStore: createB2ObjectStore(config),
    notify: (notification) =>
      sendBackupNotification(notification, config.heartbeatUrl, config.failureAlertUrl),
  });
}

main().catch(() => {
  process.exitCode = 1;
});
