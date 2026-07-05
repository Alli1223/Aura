import { useState } from 'react';

import { ErrorState } from '../../components/ErrorState';
import { Spinner } from '../../components/Spinner';
import {
  useAdminLibraries,
  useCreateLibrary,
  useDeleteLibrary,
  useLibraryScan,
  useScanAll,
  useStartScan,
  useUpdateLibrary,
  type ScanState,
} from '../../api/admin';
import type { Library, LibraryType } from '../../api/types';
import { Dialog } from './Dialog';
import { errorMessage } from './adminHelpers';
import styles from './Admin.module.css';

const LIBRARY_TYPES: LibraryType[] = ['movies', 'tv', 'anime', 'recordings', 'other'];

// Stable ids for path-input rows so add/remove keeps focus and state aligned.
let pathRowSeq = 0;
const nextPathId = () => (pathRowSeq += 1);

export function AdminLibrariesPage() {
  const libraries = useAdminLibraries();
  const scanAll = useScanAll();

  const [editing, setEditing] = useState<Library | 'new' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Library | null>(null);
  const [activeScans, setActiveScans] = useState<Set<string>>(new Set());
  const [banner, setBanner] = useState<string | null>(null);

  const markActive = (ids: string[]) =>
    setActiveScans((current) => {
      const next = new Set(current);
      for (const id of ids) next.add(id);
      return next;
    });

  const handleScanAll = () => {
    setBanner(null);
    scanAll.mutate(undefined, {
      onSuccess: (results) => markActive(results.filter((r) => r.started).map((r) => r.libraryId)),
      onError: (error) => setBanner(errorMessage(error)),
    });
  };

  if (libraries.isPending) {
    return (
      <div className={styles.stateBlock}>
        <Spinner label="Loading libraries" />
      </div>
    );
  }

  if (libraries.isError) {
    return (
      <ErrorState
        title="Couldn't load libraries"
        message={errorMessage(libraries.error)}
        onRetry={() => void libraries.refetch()}
      />
    );
  }

  return (
    <section className={styles.section} aria-labelledby="admin-libraries-heading">
      <div className={styles.toolbar}>
        <h2 id="admin-libraries-heading" className={styles.toolbarTitle}>
          Libraries ({libraries.data.length})
        </h2>
        <div className={styles.toolbarActions}>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={scanAll.isPending || libraries.data.length === 0}
            onClick={handleScanAll}
          >
            {scanAll.isPending ? 'Starting…' : 'Scan all'}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
            New library
          </button>
        </div>
      </div>

      {banner !== null && (
        <p className="alert alert-error" role="alert">
          {banner}
        </p>
      )}

      {libraries.data.length === 0 ? (
        <div className={styles.stateBlock}>
          No libraries yet. Create one to point Aura at your media folders.
        </div>
      ) : (
        <div className={styles.libGrid}>
          {libraries.data.map((library) => (
            <LibraryCard
              key={library.id}
              library={library}
              active={activeScans.has(library.id)}
              onScan={() => markActive([library.id])}
              onEdit={() => setEditing(library)}
              onDelete={() => setConfirmDelete(library)}
            />
          ))}
        </div>
      )}

      {editing !== null && (
        <LibraryFormDialog
          library={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}

      {confirmDelete !== null && (
        <DeleteLibraryDialog library={confirmDelete} onClose={() => setConfirmDelete(null)} />
      )}
    </section>
  );
}

// ---- Library card -----------------------------------------------------------

function LibraryCard({
  library,
  active,
  onScan,
  onEdit,
  onDelete,
}: {
  library: Library;
  active: boolean;
  onScan: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const startScan = useStartScan();
  const [scanError, setScanError] = useState<string | null>(null);

  const handleScan = () => {
    setScanError(null);
    onScan();
    startScan.mutate(library.id, { onError: (error) => setScanError(errorMessage(error)) });
  };

  return (
    <article className={styles.libCard}>
      <div className={styles.libHead}>
        <div>
          <div className={styles.libName}>{library.name}</div>
          <span className={`${styles.badge} ${styles.badgeNeutral}`}>{library.type}</span>
        </div>
        <div className={styles.rowActions}>
          <button type="button" className={`btn btn-ghost ${styles.btnSm}`} onClick={onEdit}>
            Edit
          </button>
          <button
            type="button"
            className={`btn btn-ghost ${styles.btnSm} ${styles.btnDanger}`}
            onClick={onDelete}
          >
            Delete
          </button>
        </div>
      </div>

      <ul className={styles.pathList}>
        {library.paths.map((path) => (
          <li key={path}>{path}</li>
        ))}
      </ul>

      <div className={styles.scanRow}>
        <button
          type="button"
          className={`btn btn-ghost ${styles.btnSm}`}
          disabled={startScan.isPending}
          onClick={handleScan}
        >
          Scan
        </button>
        <LibraryScanStatus libraryId={library.id} active={active} />
        {scanError !== null && (
          <span className={styles.scanStats} role="alert">
            {scanError}
          </span>
        )}
      </div>
    </article>
  );
}

// ---- Live scan status -------------------------------------------------------

function scanSummary(scan: ScanState): string {
  const stats = scan.stats;
  if (stats === null) return scan.status === 'scanning' ? 'Starting…' : 'No scan yet';
  const parts = [
    `${stats.filesSeen} seen`,
    `${stats.filesAdded} added`,
    `${stats.filesUpdated} updated`,
    `${stats.itemsCreated} items`,
  ];
  if (stats.filesMissing > 0) parts.push(`${stats.filesMissing} removed`);
  if (stats.errors.length > 0) parts.push(`${stats.errors.length} errors`);
  return parts.join(' · ');
}

function LibraryScanStatus({ libraryId, active }: { libraryId: string; active: boolean }) {
  const scan = useLibraryScan(libraryId, { enabled: active });

  if (!active || scan.isPending) return null;
  if (scan.isError) {
    return (
      <span className={styles.scanStats} role="alert">
        Couldn&apos;t read scan status
      </span>
    );
  }

  const isScanning = scan.data.status === 'scanning';
  return (
    <span className={styles.scanStats} role="status" aria-live="polite">
      {isScanning && <span className={`${styles.badge} ${styles.badgeWarn}`}>Scanning…</span>}{' '}
      {scan.data.error !== null ? `Scan failed: ${scan.data.error}` : scanSummary(scan.data)}
    </span>
  );
}

// ---- Create / edit dialog ---------------------------------------------------

function LibraryFormDialog({ library, onClose }: { library: Library | null; onClose: () => void }) {
  const isEdit = library !== null;
  const createLibrary = useCreateLibrary();
  const updateLibrary = useUpdateLibrary();

  const [name, setName] = useState(library?.name ?? '');
  const [type, setType] = useState<LibraryType>(library?.type ?? 'movies');
  const [paths, setPaths] = useState<{ id: number; value: string }[]>(() => {
    const initial = library && library.paths.length > 0 ? library.paths : [''];
    return initial.map((value) => ({ id: nextPathId(), value }));
  });
  const [error, setError] = useState<string | null>(null);

  const pending = createLibrary.isPending || updateLibrary.isPending;

  const setPath = (id: number, value: string) =>
    setPaths((current) => current.map((path) => (path.id === id ? { ...path, value } : path)));
  const addPath = () => setPaths((current) => [...current, { id: nextPathId(), value: '' }]);
  const removePath = (id: number) =>
    setPaths((current) => (current.length <= 1 ? current : current.filter((path) => path.id !== id)));

  const submit = () => {
    setError(null);
    const trimmedName = name.trim();
    const cleanPaths = paths.map((path) => path.value.trim()).filter((path) => path !== '');
    if (trimmedName === '') {
      setError('A library name is required.');
      return;
    }
    if (cleanPaths.length === 0) {
      setError('At least one folder path is required.');
      return;
    }

    if (isEdit) {
      updateLibrary.mutate(
        { id: library.id, input: { name: trimmedName, paths: cleanPaths } },
        { onSuccess: onClose, onError: (err) => setError(errorMessage(err)) },
      );
    } else {
      createLibrary.mutate(
        { name: trimmedName, type, paths: cleanPaths },
        { onSuccess: onClose, onError: (err) => setError(errorMessage(err)) },
      );
    }
  };

  return (
    <Dialog
      title={isEdit ? 'Edit library' : 'New library'}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={pending} onClick={submit}>
            {pending ? 'Saving…' : isEdit ? 'Save changes' : 'Create library'}
          </button>
        </>
      }
    >
      <div className={styles.form}>
        <div className={styles.formRow}>
          <label className="field-label" htmlFor="library-name">
            Name
          </label>
          <input
            id="library-name"
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        <div className={styles.formRow}>
          <label className="field-label" htmlFor="library-type">
            Type
          </label>
          <select
            id="library-type"
            className="input"
            value={type}
            disabled={isEdit}
            onChange={(event) => setType(event.target.value as LibraryType)}
          >
            {LIBRARY_TYPES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          {isEdit && <span className={styles.hint}>A library&apos;s type cannot be changed.</span>}
        </div>

        <div className={styles.formRow}>
          <span className="field-label">Folder paths</span>
          {paths.map((path, index) => (
            <div key={path.id} className={styles.pathRow}>
              <input
                className="input"
                value={path.value}
                placeholder="/media/movies"
                aria-label={`Path ${index + 1}`}
                onChange={(event) => setPath(path.id, event.target.value)}
              />
              <button
                type="button"
                className={`btn btn-ghost ${styles.btnSm}`}
                disabled={paths.length <= 1}
                aria-label={`Remove path ${index + 1}`}
                onClick={() => removePath(path.id)}
              >
                Remove
              </button>
            </div>
          ))}
          <button type="button" className={`btn btn-ghost ${styles.btnSm}`} onClick={addPath}>
            Add path
          </button>
        </div>

        {error !== null && (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

// ---- Delete dialog ----------------------------------------------------------

function DeleteLibraryDialog({ library, onClose }: { library: Library; onClose: () => void }) {
  const deleteLibrary = useDeleteLibrary();
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    setError(null);
    deleteLibrary.mutate(library.id, {
      onSuccess: onClose,
      onError: (err) => setError(errorMessage(err)),
    });
  };

  return (
    <Dialog
      title="Delete library"
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={`btn btn-primary ${styles.btnDanger}`}
            disabled={deleteLibrary.isPending}
            onClick={submit}
          >
            {deleteLibrary.isPending ? 'Deleting…' : 'Delete library'}
          </button>
        </>
      }
    >
      <p>
        Delete <strong>{library.name}</strong>? Its media items, files and access grants are
        removed. The media files on disk are left untouched.
      </p>
      {error !== null && (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
