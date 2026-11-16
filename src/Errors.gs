/**
 * Errors.gs — typed errors. WebApp.gs turns these into structured responses for the browser.
 */
class AppError extends Error {
  constructor(message, details) {
    super(message);
    this.name = this.constructor.name;
    this.details = details || null;
  }
}

/** Something tried to create/alter/drop a table, dataset, view, Sheet tab or column (D23). */
class TableCreationForbiddenError extends AppError {}
/** Another user saved the same record first (optimistic concurrency, §6.3). */
class ConflictError extends AppError {}
/** The write lock could not be obtained in time; the browser retries automatically (§6.1). */
class BusyError extends AppError {}
/** A developer-created table or Sheet tab is missing or has the wrong columns. */
class SchemaMissingError extends AppError {}
/** A required developer setting (QueryConfig.gs / Script Properties) is missing. */
class ConfigMissingError extends AppError {}
/** Input failed validation. */
class ValidationError extends AppError {}
/** The caller is not allowed to do this. */
class PermissionError extends AppError {}
/** The record does not exist. */
class NotFoundError extends AppError {}
