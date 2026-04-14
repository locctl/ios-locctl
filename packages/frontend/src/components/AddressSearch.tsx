import React, { useState, useRef, useEffect, useCallback } from 'react';
import { searchAddress } from '../services/api';
import { useT } from '../i18n';

interface SearchResult {
  name: string;
  lat: number;
  lng: number;
  address?: string;
}

interface AddressSearchProps {
  onSelect: (lat: number, lng: number, name: string) => void;
}

const AddressSearch: React.FC<AddressSearchProps> = ({ onSelect }) => {
  const t = useT();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const doSearch = useCallback(async (q: string) => {
    if (q.trim().length < 2) {
      setResults([]);
      setShowResults(false);
      return;
    }

    setIsLoading(true);
    try {
      const raw = await searchAddress(q);
      const mapped = (Array.isArray(raw) ? raw : []).map((r: any) => ({
        name: r.display_name || r.name || '',
        lat: r.lat,
        lng: r.lng,
        address: r.address || '',
      }));
      setResults(mapped);
      setShowResults(true);
    } catch (err) {
      console.error('Search failed:', err);
      setResults([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setQuery(value);

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    debounceRef.current = setTimeout(() => {
      doSearch(value);
    }, 300);
  };

  const handleSelect = (result: SearchResult) => {
    setQuery(result.name);
    setShowResults(false);
    onSelect(result.lat, result.lng, result.name);
  };

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowResults(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <div style={{ position: 'relative' }}>
        <input
          type="text"
          className="search-input"
          placeholder={t('search.placeholder')}
          value={query}
          onChange={handleInputChange}
          onFocus={() => {
            if (results.length > 0) setShowResults(true);
          }}
          style={{ width: '100%', paddingRight: 30 }}
        />
        {/* Search icon */}
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          style={{
            position: 'absolute',
            right: 8,
            top: '50%',
            transform: 'translateY(-50%)',
            opacity: 0.4,
            pointerEvents: 'none',
          }}
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      </div>

      {isLoading && (
        <div style={{ fontSize: 11, opacity: 0.5, padding: '4px 0' }}>{t('search.searching')}</div>
      )}

      {showResults && results.length > 0 && (
        <div
          className="search-results"
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            background: '#2a2a2e',
            color: '#e8eaf0',
            border: '1px solid #444',
            borderRadius: 4,
            marginTop: 4,
            maxHeight: 240,
            overflowY: 'auto',
            zIndex: 200,
            boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
          }}
        >
          {results.map((result, idx) => (
            <div
              key={idx}
              className="search-result-item"
              style={{
                padding: '8px 12px',
                cursor: 'pointer',
                borderBottom: idx < results.length - 1 ? '1px solid #333' : 'none',
                fontSize: 13,
                transition: 'background 0.15s',
              }}
              onClick={() => handleSelect(result)}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLDivElement).style.background = '#3a3a3e';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLDivElement).style.background = 'transparent';
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  style={{ flexShrink: 0, opacity: 0.5 }}
                >
                  <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z" />
                  <circle cx="12" cy="10" r="3" />
                </svg>
                <div style={{ minWidth: 0 }}>
                  <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {result.name}
                  </div>
                  {result.address && (
                    <div style={{ fontSize: 10, opacity: 0.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {result.address}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {showResults && !isLoading && results.length === 0 && query.trim().length >= 2 && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            background: '#2a2a2e',
            border: '1px solid #444',
            borderRadius: 4,
            marginTop: 4,
            padding: '12px',
            fontSize: 12,
            opacity: 0.6,
            textAlign: 'center',
            zIndex: 200,
          }}
        >
          {t('search.no_results')}
        </div>
      )}
    </div>
  );
};

export default AddressSearch;
