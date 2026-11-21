import type { EditEvent, JSX, SpanData, Tone, UndoEvent } from '@stencil-hq/tern';
import {
  buildGitSidebarEntries,
  gitFileKey,
  type GitChangeArea,
  type GitChangedFile,
  type GitChangeKind,
  type GitDiffViewMode,
  type GitOverlayState,
  type GitSidebarEntry,
  type GitSidebarStyle,
} from '../state/git_tui';

export const GIT_SUMMARY_INPUT_ID = 'layer.git.app.side.commit.summary.input';
export const GIT_BODY_EDITOR_ID = 'layer.git.app.side.commit.body';
export const GIT_LIST_UNSTAGED_PREFIX = 'layer.git.app.side.changes.unstaged.';
export const GIT_LIST_STAGED_PREFIX = 'layer.git.app.side.changes.staged.';
export const GIT_LIST_COMMIT_PREFIX = 'layer.git.app.side.commit-wrap.commit-files.';

const SUMMARY_LIMIT = 72;

export interface GitOverlayCallbacks {
  readonly onClose: () => void;
  readonly onRefresh: () => void;
  readonly onSelectFile: (file: GitChangedFile) => void;
  readonly onStepFile: (delta: -1 | 1) => void;
  readonly onSetViewMode: (mode: GitDiffViewMode) => void;
  readonly onToggleWrap: () => void;
  readonly onSetSidebarStyle: (style: GitSidebarStyle) => void;
  readonly onToggleSectionFold: (area: 'unstaged' | 'staged') => void;
  readonly onToggleDirFold: (dirKey: string) => void;
  readonly onStageFile: (file: GitChangedFile) => void;
  readonly onUnstageFile: (file: GitChangedFile) => void;
  readonly onStageAll: () => void;
  readonly onUnstageAll: () => void;
  readonly onFocusField: (field: 'summary' | 'description' | null) => void;
  readonly onSummaryEdit: (ev: EditEvent) => void;
  readonly onSummaryUndo: (ev: UndoEvent) => void;
  readonly onBodyEdit: (ev: EditEvent) => void;
  readonly onBodyUndo: (ev: UndoEvent) => void;
  readonly onToggleAmend: () => void;
  readonly onCommit: () => void;
}

export interface GitOverlayViewProps {
  readonly git: GitOverlayState;
  readonly callbacks: GitOverlayCallbacks;
}

const KIND_LETTER: Readonly<Record<GitChangeKind, string>> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: '?',
  conflicted: '!',
};

const KIND_TONE: Readonly<Record<GitChangeKind, Tone>> = {
  modified: 'warning',
  added: 'success',
  deleted: 'error',
  renamed: 'info',
  untracked: 'muted',
  conflicted: 'error',
};

function sanitizeGitNodeKey(raw: string, fallback: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, '_');
  return cleaned.length > 0 ? cleaned : fallback;
}

function findSelectedFile(git: GitOverlayState): GitChangedFile | null {
  const snap = git.snapshot;
  if (!snap || !git.selectedFileKey) return null;
  if (snap.clean) {
    return (
      snap.headCommit?.files.find(f => gitFileKey('commit', f.path) === git.selectedFileKey) ?? null
    );
  }
  return (
    snap.unstaged.find(f => gitFileKey('unstaged', f.path) === git.selectedFileKey) ??
    snap.staged.find(f => gitFileKey('staged', f.path) === git.selectedFileKey) ??
    null
  );
}

function renderFileList(
  listKey: 'unstaged' | 'staged' | 'commit-files',
  listPrefix: string,
  entries: readonly GitSidebarEntry[],
  selectedFileKey: string | null,
  style: GitSidebarStyle,
  emptyText: string,
  callbacks: GitOverlayCallbacks,
): JSX.Element {
  const usedKeys = new Set<string>();
  const keyToEntry = new Map<string, GitSidebarEntry>();
  const keyedEntries = entries.map((entry, idx) => {
    let nodeKey = sanitizeGitNodeKey(entry.key, `entry-${idx}`);
    if (usedKeys.has(nodeKey)) {
      nodeKey = `${nodeKey}_${idx}`;
    }
    usedKeys.add(nodeKey);
    keyToEntry.set(nodeKey, entry);
    return { entry, nodeKey };
  });

  const selectedEntry = keyedEntries.find(e => e.entry.key === selectedFileKey);
  const selectedNodeId = selectedEntry ? `${listPrefix}${selectedEntry.nodeKey}` : undefined;

  const resolveEntry = (raw: string | undefined): GitSidebarEntry | undefined => {
    if (!raw) return undefined;
    const stripped = raw.startsWith(listPrefix) ? raw.slice(listPrefix.length) : raw;
    return keyToEntry.get(stripped);
  };

  const handleSelect = (raw: string | undefined) => {
    const entry = resolveEntry(raw);
    if (!entry) return;
    if (entry.kind === 'dir') {
      callbacks.onToggleDirFold(entry.key);
      return;
    }
    if (entry.file) {
      callbacks.onSelectFile(entry.file);
    }
  };

  const handleActivate = (raw: string | undefined) => {
    const entry = resolveEntry(raw);
    if (!entry) return;
    if (entry.kind === 'dir') {
      callbacks.onToggleDirFold(entry.key);
      return;
    }
    if (!entry.file) return;
    if (entry.file.area === 'unstaged') {
      callbacks.onStageFile(entry.file);
    } else if (entry.file.area === 'staged') {
      callbacks.onUnstageFile(entry.file);
    } else {
      callbacks.onSelectFile(entry.file);
    }
  };

  return (
    <list
      key={listKey}
      role="omp.app.git.files"
      selected={selectedNodeId}
      empty={emptyText}
      actions={{ click: 'select', dblclick: 'activate' }}
      onSelect={ev => handleSelect(ev.item)}
      onActivate={ev => handleActivate(ev.item)}
      onAction={{
        select: ev =>
          handleSelect(
            typeof ev.item === 'string'
              ? ev.item
              : typeof ev.value === 'string'
                ? ev.value
                : undefined,
          ),
        activate: ev =>
          handleActivate(
            typeof ev.item === 'string'
              ? ev.item
              : typeof ev.value === 'string'
                ? ev.value
                : undefined,
          ),
      }}
    >
      {keyedEntries.map(({ entry, nodeKey }) => {
        if (entry.kind === 'dir') {
          return (
            <item
              key={nodeKey}
              label={entry.dirName ?? ''}
              icon="folder"
              role={`omp.app.git.dir-d${entry.depth}`}
              tone={entry.collapsed ? 'muted' : undefined}
            />
          );
        }
        const file = entry.file!;
        const slash = file.path.lastIndexOf('/');
        const label: SpanData[] =
          style === 'tree' || slash < 0
            ? [{ t: file.path.slice(slash + 1) }]
            : [
                { t: file.path.slice(0, slash + 1), s: 'dim' },
                { t: file.path.slice(slash + 1) },
              ];
        const stats: SpanData[] = [];
        if (file.additions) stats.push({ t: `+${file.additions}`, s: 'ins num' });
        if (file.deletions) {
          stats.push({ t: `${stats.length > 0 ? ' ' : ''}−${file.deletions}`, s: 'del num' });
        }
        return (
          <item
            key={nodeKey}
            label={label}
            detail={file.origPath ? [{ t: `from ${file.origPath}`, s: 'dim' }] : undefined}
            value={stats.length > 0 ? stats : undefined}
            hint={[KIND_LETTER[file.kind]]}
            tone={KIND_TONE[file.kind]}
            role={`omp.app.git.file-d${style === 'tree' ? entry.depth : 0}`}
            title={`${file.kind}: ${file.path}${
              file.area === 'unstaged'
                ? ' (double-click or Space to stage)'
                : file.area === 'staged'
                  ? ' (double-click or Space to unstage)'
                  : ''
            }`}
          />
        );
      })}
    </list>
  );
}

/**
 * Fullscreen Git UI aligned 1:1 with `omp`'s native `omp.app.git` TSP surface
 * (automatically styled by Tern's preloaded `omp-apps.css`):
 * - Left main diff pane with toolbar (path, `+a −d`, scope badge, prev/next file,
 *   Split/Inline/File segmented control, wrap, refresh, Stage/Unstage file, Close)
 *   and native `<diff role="omp.app.git.diff">`
 * - Right sidebar (`omp.app.git.side`):
 *   - Dirty tree: `N changes on <branch>`, Path/Tree toggle, collapsible Unstaged/Staged
 *     lists with Stage all / Unstage all, and docked Summary/Description/Amend/Commit form
 *   - Clean tree: HEAD commit card (subject, message, author avatar, metadata `<kv>`)
 *     over HEAD commit's changed files
 */
export function GitOverlayView(props: GitOverlayViewProps): JSX.Element {
  const { git, callbacks } = props;
  const snap = git.snapshot;
  const selectedFile = findSelectedFile(git);

  const renderToolbar = (): JSX.Element => {
    const leftNodes: JSX.Element[] = [];
    if (selectedFile) {
      const slash = selectedFile.path.lastIndexOf('/');
      leftNodes.push(
        <text
          key="path"
          role="omp.app.git.path"
          truncate="start"
          title={
            selectedFile.origPath
              ? `${selectedFile.origPath} → ${selectedFile.path}`
              : selectedFile.path
          }
          spans={[
            { t: selectedFile.path.slice(0, slash + 1), s: 'dim' },
            { t: selectedFile.path.slice(slash + 1), s: 'strong' },
          ]}
        />,
      );
      const adds =
        git.diff && git.diff.fileKey === git.selectedFileKey
          ? git.diff.additions
          : selectedFile.additions;
      const dels =
        git.diff && git.diff.fileKey === git.selectedFileKey
          ? git.diff.deletions
          : selectedFile.deletions;
      if (adds !== undefined || dels !== undefined) {
        leftNodes.push(
          <text
            key="stat"
            role="omp.app.git.stat"
            spans={[
              { t: `+${adds ?? 0}`, s: 'ins num' },
              { t: ' ' },
              { t: `−${dels ?? 0}`, s: 'del num' },
            ]}
          />,
        );
      }
      const scope =
        selectedFile.area === 'staged'
          ? { text: 'Staged', tone: 'success' as const }
          : selectedFile.area === 'unstaged'
            ? {
                text: selectedFile.kind === 'untracked' ? 'Untracked' : 'Unstaged',
                tone: 'warning' as const,
              }
            : { text: snap?.headCommit?.shortSha ?? 'commit', tone: 'accent' as const };
      leftNodes.push(<badge key="scope" text={scope.text} tone={scope.tone} />);
    } else {
      leftNodes.push(
        <text
          key="path"
          role="omp.app.git.path"
          spans={[{ t: snap?.branch ?? 'Git', s: 'muted' }]}
        />,
      );
    }

    const canStageSelected = selectedFile?.area === 'unstaged';
    const canUnstageSelected = selectedFile?.area === 'staged';

    return (
      <row key="bar" role="omp.app.git.bar" justify="between" align="center">
        <row key="where" role="omp.app.git.where" gap="sm" align="center">
          {leftNodes}
        </row>
        <row key="tools" role="omp.app.git.tools" gap="sm" align="center">
          <row key="nav" gap="none" align="center">
            <button
              key="prev"
              role="omp.app.ibtn"
              icon="chev-up"
              title="Previous file ([)"
              actions={{ click: 'git.prev' }}
              onClick={() => callbacks.onStepFile(-1)}
            />
            <button
              key="next"
              role="omp.app.ibtn"
              icon="chev"
              title="Next file (])"
              actions={{ click: 'git.next' }}
              onClick={() => callbacks.onStepFile(1)}
            />
          </row>
          <tabs
            key="views"
            role="omp.app.seg"
            variant="seg"
            active={git.viewMode}
            items={[
              { id: 'split', label: 'Split' },
              { id: 'inline', label: 'Inline' },
              { id: 'file', label: 'File' },
            ]}
            onSelect={ev => {
              if (ev.item === 'split' || ev.item === 'inline' || ev.item === 'file') {
                callbacks.onSetViewMode(ev.item);
              }
            }}
          />
          <button
            key="wrap"
            role={git.wrap ? 'omp.app.ibtn.set' : 'omp.app.ibtn'}
            icon="corner-down-right"
            title="Wrap long lines (w)"
            on={git.wrap}
            actions={{ click: 'git.wrap' }}
            onClick={() => callbacks.onToggleWrap()}
          />
          <button
            key="refresh"
            role="omp.app.ibtn"
            icon="repeat"
            title="Refresh repository (r)"
            actions={{ click: 'git.refresh' }}
            onClick={() => callbacks.onRefresh()}
          />
          {canStageSelected && selectedFile ? (
            <button
              key="stage-file"
              role="omp.btn"
              size="sm"
              keys={['s']}
              title={`Stage ${selectedFile.path}`}
              actions={{ click: 'git.stage-file' }}
              onClick={() => callbacks.onStageFile(selectedFile)}
            >
              Stage file
            </button>
          ) : canUnstageSelected && selectedFile ? (
            <button
              key="unstage-file"
              role="omp.btn"
              size="sm"
              keys={['s']}
              title={`Unstage ${selectedFile.path}`}
              actions={{ click: 'git.unstage-file' }}
              onClick={() => callbacks.onUnstageFile(selectedFile)}
            >
              Unstage file
            </button>
          ) : null}
          <button
            key="close"
            role="omp.app.ibtn"
            icon="x"
            title="Close (Esc / q)"
            actions={{ click: 'git.close' }}
            onClick={() => callbacks.onClose()}
          />
        </row>
      </row>
    );
  };

  const renderDiffBody = (): JSX.Element => {
    if (git.loading && !snap) {
      return (
        <row key="loading" role="omp.app.git.state" gap="sm" align="center">
          <spinner key="sp" style="dots" />
          <text key="lbl" spans={[{ t: 'Loading repository status…', s: 'muted' }]} />
        </row>
      );
    }
    if (git.error && !snap) {
      return (
        <col key="err" role="omp.app.git.empty" gap="xs">
          <text key="t" spans={[{ t: 'Not a Git repository', s: 'strong' }]} />
          <text key="m" spans={[{ t: git.error, s: 'error' }]} wrap="word" />
        </col>
      );
    }
    if (git.diffLoading) {
      return (
        <row key="loading" role="omp.app.git.state" gap="sm" align="center">
          <spinner key="sp" style="dots" />
          <text
            key="lbl"
            spans={[{ t: `Loading ${selectedFile?.path ?? 'diff'}…`, s: 'muted' }]}
          />
        </row>
      );
    }
    if (git.diff && git.diff.kind === 'diff' && selectedFile) {
      return (
        <diff
          key={`diff-${sanitizeGitNodeKey(git.diff.fileKey, 'file')}-${git.viewMode}`}
          role="omp.app.git.diff"
          text={git.diff.unifiedDiff}
          path={git.diff.filePath}
          mode={git.viewMode === 'split' ? 'split' : 'unified'}
        />
      );
    }
    if (git.diff && git.diff.kind !== 'diff') {
      return (
        <col key="state" role="omp.app.git.empty" gap="xs">
          <text
            key="t"
            spans={[
              {
                t:
                  git.diff.kind === 'binary'
                    ? 'Binary file'
                    : git.diff.kind === 'tooLarge'
                      ? 'File too large to diff'
                      : git.diff.kind === 'error'
                        ? 'Unable to load diff'
                        : 'No differences',
                s: 'strong',
              },
            ]}
          />
          {git.diff.message ? (
            <text key="m" spans={[{ t: git.diff.message, s: 'muted' }]} wrap="word" />
          ) : null}
        </col>
      );
    }
    return (
      <col key="empty" role="omp.app.git.empty" gap="xs">
        <text
          key="t"
          spans={[
            {
              t: snap?.clean && !snap.headCommit ? 'No commits yet' : 'No file selected',
              s: 'strong',
            },
          ]}
        />
        <text
          key="m"
          spans={[
            {
              t: snap?.clean
                ? 'The working tree is clean. Pick a file on the right to inspect the HEAD commit.'
                : 'Pick a changed file on the right to inspect its diff.',
              s: 'muted',
            },
          ]}
        />
      </col>
    );
  };

  const renderStyleToggle = (): JSX.Element => (
    <tabs
      key="style"
      role="omp.app.seg"
      variant="seg"
      active={git.sidebarStyle}
      items={[
        { id: 'path', label: 'Path' },
        { id: 'tree', label: 'Tree' },
      ]}
      onSelect={ev => {
        if (ev.item === 'path' || ev.item === 'tree') {
          callbacks.onSetSidebarStyle(ev.item);
        }
      }}
    />
  );

  const renderSection = (
    area: 'unstaged' | 'staged',
    files: readonly GitChangedFile[],
  ): JSX.Element[] => {
    const folded = Boolean(git.foldedSections[area]);
    const listPrefix = area === 'unstaged' ? GIT_LIST_UNSTAGED_PREFIX : GIT_LIST_STAGED_PREFIX;
    const out: JSX.Element[] = [
      <row
        key={`${area}-head`}
        role="omp.app.git.sechead"
        justify="between"
        align="center"
      >
        <row
          key="toggle"
          gap="xs"
          align="center"
          title={folded ? 'Show section' : 'Hide section'}
          actions={{ click: `git.fold-${area}` }}
          onClick={() => callbacks.onToggleSectionFold(area)}
        >
          <icon key="ic" name={folded ? 'chev-r' : 'chev'} />
          <text key="lbl" text={area === 'unstaged' ? 'Unstaged' : 'Staged'} />
          <text key="cnt" role="omp.app.git.count" spans={[{ t: String(files.length), s: 'num' }]} />
        </row>
        <row key="acts" role="omp.app.git.acts" gap="xs" align="center">
          {files.length > 0 ? (
            area === 'unstaged' ? (
              <button
                key="stage-all"
                role="omp.app.qbtn"
                size="sm"
                title="Stage all changes"
                actions={{ click: 'git.stage-all' }}
                onClick={() => callbacks.onStageAll()}
              >
                Stage all
              </button>
            ) : (
              <button
                key="unstage-all"
                role="omp.app.qbtn"
                size="sm"
                title="Unstage all changes"
                actions={{ click: 'git.unstage-all' }}
                onClick={() => callbacks.onUnstageAll()}
              >
                Unstage all
              </button>
            )
          ) : null}
        </row>
      </row>,
    ];

    if (!folded) {
      const entries = buildGitSidebarEntries(files, area, git.sidebarStyle, git.foldedDirs);
      out.push(
        renderFileList(
          area,
          listPrefix,
          entries,
          git.selectedFileKey,
          git.sidebarStyle,
          area === 'unstaged' ? 'Nothing to stage' : 'Nothing staged yet',
          callbacks,
        ),
      );
    }
    return out;
  };

  const renderCommitForm = (): JSX.Element => {
    const stagedCount = snap?.staged.length ?? 0;
    const unstagedCount = snap?.unstaged.length ?? 0;
    const hasChanges = stagedCount > 0 || unstagedCount > 0 || git.commitAmend;
    const summaryTrim = git.commitSummary.trim();
    const canCommit = hasChanges && !git.busy && (summaryTrim.length > 0 || git.commitAmend);
    const charsLeft = SUMMARY_LIMIT - git.commitSummary.length;
    const commitLabel = git.busy
      ? 'Committing…'
      : git.commitAmend
        ? 'Amend commit'
        : stagedCount > 0
          ? 'Commit'
          : 'Stage all & commit';

    return (
      <col key="commit" role="omp.app.git.commit" gap="sm">
        <row
          key="summary"
          role={git.focusedField === 'summary' ? 'omp.app.git.summary.on' : 'omp.app.git.summary'}
          gap="sm"
          align="center"
          actions={{ click: 'git.focus-summary' }}
          onClick={() => callbacks.onFocusField('summary')}
        >
          <input
            key="input"
            text={git.commitSummary}
            cursor={git.commitSummary.length}
            placeholder="Summary (press c to edit)"
            grow={1}
            onEdit={ev => callbacks.onSummaryEdit(ev)}
            onUndo={ev => callbacks.onSummaryUndo(ev)}
            onFocus={() => callbacks.onFocusField('summary')}
          />
          {git.commitSummary.length > 0 ? (
            <text
              key="left"
              role="omp.app.git.count"
              spans={[{ t: String(charsLeft), s: charsLeft < 0 ? 'warning num' : 'num' }]}
            />
          ) : null}
        </row>
        <editor
          key="body"
          role={git.focusedField === 'description' ? 'omp.app.git.body.on' : 'omp.app.git.body'}
          text={git.commitBody}
          cursor={git.commitBody.length}
          placeholder="Description (optional)"
          maxLines={4}
          onEdit={ev => callbacks.onBodyEdit(ev)}
          onUndo={ev => callbacks.onBodyUndo(ev)}
          onFocus={() => callbacks.onFocusField('description')}
        />
        <row key="foot" role="omp.app.git.foot" justify="between" align="center">
          <row
            key="amend"
            role={git.commitAmend ? 'omp.app.git.toggle.set' : 'omp.app.git.toggle'}
            gap="xs"
            align="center"
            title="Amend the previous commit"
            actions={{ click: 'git.amend' }}
            onClick={() => callbacks.onToggleAmend()}
          >
            <icon key="ic" name={git.commitAmend ? 'check' : 'commit'} />
            <text key="lbl" text="Amend" />
          </row>
          <button
            key="commit-btn"
            role="omp.btn"
            size="sm"
            tone={canCommit ? 'accent' : 'muted'}
            disabled={!canCommit}
            title={
              !hasChanges
                ? 'Nothing to commit'
                : !summaryTrim && !git.commitAmend
                  ? 'Write a summary line first'
                  : stagedCount > 0
                    ? 'Commit staged changes'
                    : 'Stage all changes and commit'
            }
            actions={{ click: 'git.commit' }}
            onClick={() => {
              if (canCommit) callbacks.onCommit();
            }}
          >
            {commitLabel}
          </button>
        </row>
      </col>
    );
  };

  const renderSidebar = (): JSX.Element => {
    if (!snap) {
      return (
        <col key="side" role="omp.app.git.side" gap="sm">
          <text
            key="empty"
            role="omp.app.git.empty"
            spans={[{ t: git.loading ? 'Loading…' : 'No repository data', s: 'muted' }]}
          />
        </col>
      );
    }

    if (snap.clean) {
      const head = snap.headCommit;
      if (!head) {
        return (
          <col key="side" role="omp.app.git.side" gap="sm">
            <text
              key="empty"
              role="omp.app.git.empty"
              spans={[{ t: 'No commits yet', s: 'muted' }]}
            />
          </col>
        );
      }

      const initials =
        head.authorName
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 2)
          .map(w => w[0]!.toUpperCase())
          .join('') || '?';
      const parsedDate = head.authorDate ? new Date(head.authorDate) : null;
      const kvItems: Array<{ k: string; v: string | SpanData[] }> = [];
      if (snap.branch) {
        kvItems.push({ k: 'branch', v: [{ t: snap.branch, s: 'mono accent' }] });
      }
      if (parsedDate && !Number.isNaN(parsedDate.getTime())) {
        kvItems.push({ k: 'authored', v: parsedDate.toLocaleString() });
      }
      if (head.parents.length > 0) {
        kvItems.push({
          k: head.parents.length === 1 ? 'parent' : 'parents',
          v: [{ t: head.parents.map(p => p.slice(0, 8)).join(' '), s: 'mono accent' }],
        });
      }

      const totalAdd = head.files.reduce((sum, f) => sum + (f.additions ?? 0), 0);
      const totalDel = head.files.reduce((sum, f) => sum + (f.deletions ?? 0), 0);
      const entries = buildGitSidebarEntries(
        head.files,
        'commit',
        git.sidebarStyle,
        git.foldedDirs,
      );

      return (
        <col key="side" role="omp.app.git.side" gap="sm">
          <col key="head" role="omp.app.git.commit-info" gap="sm">
            <text
              key="subject"
              role="omp.app.git.subject"
              wrap="word"
              spans={[{ t: head.subject || '(no subject)', s: 'strong' }]}
            />
            {head.body.trim().length > 0 ? (
              <text
                key="message"
                role="omp.app.git.message"
                wrap="word"
                lines={6}
                text={head.body.trim()}
              />
            ) : null}
            <row key="author" role="omp.app.git.author" gap="sm" align="center">
              <text key="avatar" role="omp.app.git.avatar" text={initials} title={head.authorEmail} />
              <col key="who" gap="none">
                <text
                  key="name"
                  truncate="end"
                  spans={[{ t: head.authorName || 'Unknown', s: 'strong' }]}
                />
                {head.authorEmail ? (
                  <text key="email" truncate="end" spans={[{ t: head.authorEmail, s: 'dim' }]} />
                ) : null}
              </col>
            </row>
            {kvItems.length > 0 ? <kv key="meta" items={kvItems} layout="grid" /> : null}
          </col>
          <row key="files-head" role="omp.app.git.head" justify="between" align="center">
            <text
              key="summary"
              spans={[
                {
                  t: `${head.files.length} file${head.files.length === 1 ? '' : 's'}`,
                  s: 'strong',
                },
                { t: '  ' },
                { t: `+${totalAdd}`, s: 'ins num' },
                { t: ' ' },
                { t: `−${totalDel}`, s: 'del num' },
                { t: `  ${head.shortSha}`, s: 'dim mono' },
              ]}
            />
            {renderStyleToggle()}
          </row>
          <col key="commit-wrap" role="omp.app.git.changes" gap="xs">
            {renderFileList(
              'commit-files',
              GIT_LIST_COMMIT_PREFIX,
              entries,
              git.selectedFileKey,
              git.sidebarStyle,
              'No files in HEAD commit',
              callbacks,
            )}
          </col>
        </col>
      );
    }

    const totalChanges = snap.unstaged.length + snap.staged.length;
    return (
      <col key="side" role="omp.app.git.side" gap="sm">
        <row key="head" role="omp.app.git.head" justify="between" align="center">
          <row key="title" role="omp.app.git.title" gap="xs" align="center">
            <text
              key="cnt"
              spans={[
                { t: `${totalChanges} change${totalChanges === 1 ? '' : 's'}`, s: 'strong' },
              ]}
            />
            {snap.branch ? <text key="on" spans={[{ t: 'on', s: 'muted' }]} /> : null}
            {snap.branch ? (
              <text
                key="branch"
                role="omp.app.git.branch"
                truncate="middle"
                spans={[{ t: snap.branch, s: 'mono' }]}
              />
            ) : null}
          </row>
          {renderStyleToggle()}
        </row>
        <col key="changes" role="omp.app.git.changes" gap="sm">
          {renderSection('unstaged', snap.unstaged)}
          {renderSection('staged', snap.staged)}
        </col>
        {renderCommitForm()}
      </col>
    );
  };

  return (
    <overlay
      key="git"
      anchor="center"
      size="full"
      modal
      role="oma.overlay.git"
    >
      <row key="app" role="omp.app.git">
        <col key="main" role="omp.app.git.main">
          {renderToolbar()}
          {git.statusMessage ? (
            <text
              key="status"
              role="omp.app.status"
              truncate="end"
              spans={[
                {
                  t: git.statusMessage.text,
                  s: git.statusMessage.tone,
                },
              ]}
            />
          ) : null}
          {renderDiffBody()}
        </col>
        {renderSidebar()}
      </row>
    </overlay>
  );
}
