import React, { useState } from 'react';
import { useT } from '../i18n';
import BookmarkSyncBar, { CloudIcon, PinIcon } from './BookmarkSyncBar';
import type { SyncStatus } from '../services/api';

interface Bookmark {
  id?: string;
  name: string;
  lat: number;
  lng: number;
  category: string;
  country?: string;
  note?: string;
  source?: 'cloud' | 'local';
  added_by?: string;
  added_at?: string;
}

interface Position {
  lat: number;
  lng: number;
}

interface BookmarkListProps {
  bookmarks: Bookmark[];
  categories: string[];
  currentPosition: Position | null;
  onBookmarkClick: (bm: Bookmark) => void;
  onOpenBookmarkCreate: (lat?: number, lng?: number) => void;
  onBookmarkDelete: (id: string) => void;
  onBookmarkEdit: (bm: Bookmark) => void;
  onCategoryAdd: (name: string) => void;
  onCategoryDelete: (name: string) => void;
  onImport?: (file: File) => Promise<void>;
  exportUrl?: string;
  // Phase B1 + B2 — Sheets sync
  syncStatus?: SyncStatus | null;
  syncing?: boolean;
  hasCloudUpdates?: boolean;
  onSync?: () => Promise<void>;
  onSetSyncConfig?: (patch: { sheet_url_or_id?: string; tab_name?: string; webhook_url?: string }) => Promise<void>;
  onUploadLocal?: () => Promise<import('../services/api').UploadResult>;
}

const CATEGORY_COLORS: Record<string, string> = {
  Default: '#4285f4',
  Home: '#4caf50',
  Work: '#ff9800',
  Favorites: '#e91e63',
  Custom: '#9c27b0',
};

function getCategoryColor(name: string): string {
  if (CATEGORY_COLORS[name]) return CATEGORY_COLORS[name];
  // Deterministic color from name
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 60%, 55%)`;
}

const BookmarkList: React.FC<BookmarkListProps> = ({
  bookmarks,
  categories,
  currentPosition,
  onBookmarkClick,
  onOpenBookmarkCreate,
  onBookmarkDelete,
  onBookmarkEdit,
  onCategoryAdd,
  onCategoryDelete,
  onImport,
  exportUrl,
  syncStatus,
  syncing,
  hasCloudUpdates,
  onSync,
  onSetSyncConfig,
  onUploadLocal,
}) => {
  const t = useT();
  const displayCat = (name: string) => name;  // backend already stores friendly names since Phase A
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [showCategoryMgr, setShowCategoryMgr] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  // Filter by source: all | cloud | local. Persists across reloads so a
  // user who likes the "我的" view doesn't have to re-pick every session.
  const [sourceFilter, setSourceFilter] = useState<'all' | 'cloud' | 'local'>(() => {
    try { return (localStorage.getItem('bm.sourceFilter') as any) || 'all'; }
    catch { return 'all'; }
  });
  const setFilter = (v: 'all' | 'cloud' | 'local') => {
    setSourceFilter(v);
    try { localStorage.setItem('bm.sourceFilter', v); } catch { /* ignore */ }
  };

  const toggleCategory = (cat: string) => {
    setCollapsed((prev) => ({ ...prev, [cat]: !prev[cat] }));
  };

  // Apply source filter once before grouping so empty categories collapse out.
  const filtered = sourceFilter === 'all'
    ? bookmarks
    : bookmarks.filter((bm) => (bm.source || 'cloud') === sourceFilter);

  const cloudCount = bookmarks.filter((bm) => (bm.source || 'cloud') === 'cloud').length;
  const localCount = bookmarks.filter((bm) => bm.source === 'local').length;

  const bookmarksByCategory = categories.reduce<Record<string, Bookmark[]>>((acc, cat) => {
    acc[cat] = filtered.filter((bm) => bm.category === cat);
    return acc;
  }, {});

  // Include uncategorized
  const uncategorized = filtered.filter((bm) => !categories.includes(bm.category));
  if (uncategorized.length > 0) {
    bookmarksByCategory['Uncategorized'] = uncategorized;
  }

  return (
    <div>
      {/* Sheets sync bar (Phase B1 + B2) */}
      {onSync && onSetSyncConfig && onUploadLocal && (
        <BookmarkSyncBar
          status={syncStatus ?? null}
          syncing={!!syncing}
          hasCloudUpdates={!!hasCloudUpdates}
          onSync={onSync}
          onSetConfig={onSetSyncConfig}
          onUpload={onUploadLocal}
        />
      )}

      {/* Source filter tabs (Phase B1) */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 8, fontSize: 11 }}>
        {([
          ['all', null, `全部 ${bookmarks.length}`],
          ['cloud', <CloudIcon key="c" />, `雲端 ${cloudCount}`],
          ['local', <PinIcon key="p" />, `本地 ${localCount}`],
        ] as Array<[typeof sourceFilter, React.ReactNode, string]>).map(([key, icon, label]) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            style={{
              padding: '3px 10px',
              borderRadius: 4,
              border: '1px solid',
              borderColor: sourceFilter === key ? 'rgba(108, 140, 255, 0.55)' : 'rgba(255,255,255,0.08)',
              background: sourceFilter === key ? 'rgba(108, 140, 255, 0.18)' : 'transparent',
              color: sourceFilter === key ? '#a8bdff' : 'rgba(255,255,255,0.55)',
              cursor: 'pointer',
              fontSize: 11,
              display: 'inline-flex',
              alignItems: 'center',
            }}
          >
            {icon}{label}
          </button>
        ))}
      </div>

      {/* Header with add / manage buttons */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <button
          className="action-btn"
          onClick={() => onOpenBookmarkCreate(currentPosition?.lat, currentPosition?.lng)}
          style={{ padding: '3px 8px', fontSize: 12 }}
          title={t('bm.add_here')}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          {t('bm.add')}
        </button>
        {exportUrl && (
          <a
            className="action-btn"
            href={exportUrl}
            download="bookmarks.csv"
            style={{ padding: '3px 8px', fontSize: 12, marginLeft: 'auto', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 3 }}
            title={t('bm.export_tooltip')}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            {t('bm.export')}
          </a>
        )}
        {onImport && (
          <label
            className="action-btn"
            style={{ padding: '3px 8px', fontSize: 12, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 3, marginLeft: exportUrl ? 0 : 'auto' }}
            title={t('bm.import_tooltip')}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            {t('bm.import')}
            <input
              type="file"
              accept="text/csv,.csv"
              style={{ display: 'none' }}
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) await onImport(f);
                e.target.value = '';
              }}
            />
          </label>
        )}
        <button
          className="action-btn"
          onClick={() => setShowCategoryMgr(!showCategoryMgr)}
          style={{ padding: '3px 8px', fontSize: 12, marginLeft: (exportUrl || onImport) ? 0 : 'auto' }}
          title={t('bm.manage_categories')}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
          </svg>
        </button>
      </div>

      {/* Category manager */}
      {showCategoryMgr && (
        <div
          style={{
            background: '#2a2a2e',
            border: '1px solid #444',
            borderRadius: 6,
            padding: 12,
            marginBottom: 8,
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 6, opacity: 0.7 }}>
            {t('bm.manage_categories')}
          </div>
          {categories.map((cat) => (
            <div
              key={cat}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 0',
                fontSize: 12,
              }}
            >
              <div
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: getCategoryColor(cat),
                  flexShrink: 0,
                }}
              />
              <span style={{ flex: 1 }}>{displayCat(cat)}</span>
              {cat !== 'Default' && (
                <button
                  onClick={() => onCategoryDelete(cat)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#f44336',
                    cursor: 'pointer',
                    padding: '2px 4px',
                    fontSize: 11,
                  }}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              )}
            </div>
          ))}
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <input
              type="text"
              className="search-input"
              placeholder={t('bm.add_category')}
              value={newCategoryName}
              onChange={(e) => setNewCategoryName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newCategoryName.trim()) {
                  onCategoryAdd(newCategoryName.trim());
                  setNewCategoryName('');
                }
              }}
              style={{ flex: 1 }}
            />
            <button
              className="action-btn"
              onClick={() => {
                if (newCategoryName.trim()) {
                  onCategoryAdd(newCategoryName.trim());
                  setNewCategoryName('');
                }
              }}
              style={{ fontSize: 11 }}
            >
              {t('bm.new_category')}
            </button>
          </div>
        </div>
      )}

      {/* Bookmark groups */}
      {Object.entries(bookmarksByCategory).map(([cat, bms]) => (
        <div key={cat} className="bookmark-group" style={{ marginBottom: 4 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '5px 4px',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 600,
              opacity: 0.8,
            }}
            onClick={() => toggleCategory(cat)}
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              style={{
                transform: collapsed[cat] ? 'rotate(0deg)' : 'rotate(90deg)',
                transition: 'transform 0.2s',
              }}
            >
              <polyline points="9,18 15,12 9,6" />
            </svg>
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: getCategoryColor(cat),
                flexShrink: 0,
              }}
            />
            <span>{displayCat(cat)}</span>
            <span style={{ marginLeft: 'auto', opacity: 0.4, fontWeight: 400, fontSize: 10 }}>
              {bms.length}
            </span>
          </div>

          {!collapsed[cat] && (
            <div style={{ paddingLeft: 20 }}>
              {bms.length === 0 && (
                <div style={{ fontSize: 11, opacity: 0.4, padding: '4px 0' }}>{t('bm.blank')}</div>
              )}
          {bms.map((bm) => (
                <div
                  key={bm.id ?? `${bm.lat}-${bm.lng}`}
                  className="bookmark-item"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '5px 6px',
                    cursor: 'pointer',
                    borderRadius: 4,
                    fontSize: 12,
                    transition: 'background 0.15s',
                  }}
                  onClick={() => onBookmarkClick(bm)}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLDivElement).style.background = '#3a3a3e';
                  }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLDivElement).style.background = 'transparent';
                    }}
                  >
                  <span
                    title={bm.source === 'local' ? '本地未上傳' : '雲端共編'}
                    style={{
                      display: 'inline-flex',
                      flexShrink: 0,
                      color: bm.source === 'local' ? '#ffc107' : '#7dd87d',
                      opacity: bm.source === 'local' ? 0.95 : 0.65,
                    }}
                  >
                    {bm.source === 'local' ? <PinIcon /> : <CloudIcon />}
                  </span>
                  <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                    <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 13, fontWeight: 600 }}>
                      {bm.country ? `${bm.name} (${bm.country})` : bm.name}
                    </span>
                    <span
                      style={{
                        fontSize: 10,
                        opacity: 0.72,
                        lineHeight: 1.3,
                        marginTop: 2,
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                        whiteSpace: 'normal',
                      }}
                    >
                      {bm.note || ' '}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                    {bm.id && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onBookmarkEdit(bm);
                        }}
                        title={t('bm.edit')}
                        style={{
                          background: 'transparent',
                          border: 'none',
                          color: 'rgba(255,255,255,0.55)',
                          cursor: 'pointer',
                          padding: '2px 4px',
                          flexShrink: 0,
                        }}
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                          <path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                        </svg>
                      </button>
                    )}
                    {bm.id && bm.source !== 'cloud' && (
                      // Cloud bookmarks are owned by the shared Sheet — by
                      // design the desktop app can't delete them; users have
                      // to remove the row in Google Sheets directly.
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm(t('bm.delete_confirm', { name: bm.name }))) {
                            onBookmarkDelete(bm.id!);
                          }
                        }}
                        title={t('generic.delete')}
                        style={{
                          background: 'transparent',
                          border: 'none',
                          color: 'rgba(255,255,255,0.55)',
                          cursor: 'pointer',
                          padding: '2px 4px',
                          flexShrink: 0,
                        }}
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <polyline points="3,6 5,6 21,6" />
                          <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                        </svg>
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
      {bookmarks.length === 0 && (
        <div style={{ fontSize: 12, opacity: 0.5, padding: '8px 0', textAlign: 'center' }}>
          {t('bm.empty')}
        </div>
      )}
    </div>
  );
};

export default BookmarkList;
