import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router';

import { isRequest } from '~/models/request';
import { isRequestGroup } from '~/models/request-group';
import type { Child } from '~/routes/organization.$organizationId.project.$projectId.workspace.$workspaceId';

interface PathNode {
  segment: string;
  fullPath: string;
  children: PathNode[];
  requests: Child[];
}

const METHOD_ORDER = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

const METHOD_BADGE_CLASSES: Record<string, string> = {
  GET: 'bg-[rgba(var(--color-surprise-rgb),0.5)] text-(--color-font-surprise)',
  POST: 'bg-[rgba(var(--color-success-rgb),0.5)] text-(--color-font-success)',
  HEAD: 'bg-[rgba(var(--color-info-rgb),0.5)] text-(--color-font-info)',
  OPTIONS: 'bg-[rgba(var(--color-info-rgb),0.5)] text-(--color-font-info)',
  DELETE: 'bg-[rgba(var(--color-danger-rgb),0.5)] text-(--color-font-danger)',
  PUT: 'bg-[rgba(var(--color-warning-rgb),0.5)] text-(--color-font-warning)',
  PATCH: 'bg-[rgba(var(--color-notice-rgb),0.5)] text-(--color-font-notice)',
};

const METHOD_SHORT: Record<string, string> = {
  GET: 'GET',
  POST: 'POST',
  PUT: 'PUT',
  PATCH: 'PTCH',
  DELETE: 'DEL',
  HEAD: 'HEAD',
  OPTIONS: 'OPT',
};

function extractPathname(url: string): string {
  try {
    const cleaned = url.replace(/\{\{[^}]*\}\}/g, 'http://placeholder');
    const parsed = new URL(cleaned.startsWith('http') ? cleaned : `http://${cleaned}`);
    return parsed.pathname;
  } catch {
    const match = url.match(/\/([^?#]*)/);
    return match ? `/${match[1]}` : '/';
  }
}

function buildTree(requests: Child[]): PathNode[] {
  const root: PathNode = { segment: '', fullPath: '', children: [], requests: [] };

  for (const item of requests) {
    if (isRequestGroup(item.doc)) {
      continue;
    }
    const pathname = extractPathname(item.doc.url || '');
    const segments = pathname.split('/').filter(Boolean);
    let node = root;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const fullPath = '/' + segments.slice(0, i + 1).join('/');
      let child = node.children.find(c => c.segment === seg);
      if (!child) {
        child = { segment: seg, fullPath, children: [], requests: [] };
        node.children.push(child);
      }
      node = child;
    }

    node.requests.push(item);
  }

  // Compress single-child intermediate nodes with no requests
  function compress(node: PathNode): PathNode {
    node.children = node.children.map(compress);

    if (node.children.length === 1 && node.requests.length === 0) {
      const child = node.children[0];
      return {
        segment: node.segment ? `${node.segment}/${child.segment}` : child.segment,
        fullPath: child.fullPath,
        children: child.children,
        requests: child.requests,
      };
    }

    return node;
  }

  const compressed = compress(root);

  function sortTree(nodes: PathNode[]): PathNode[] {
    return nodes
      .sort((a, b) => a.segment.localeCompare(b.segment))
      .map(n => ({ ...n, children: sortTree(n.children) }));
  }

  return sortTree(compressed.children);
}

function sortRequests(requests: Child[]): Child[] {
  return [...requests].sort((a, b) => {
    if (isRequest(a.doc) && isRequest(b.doc)) {
      const aIdx = METHOD_ORDER.indexOf(a.doc.method);
      const bIdx = METHOD_ORDER.indexOf(b.doc.method);
      return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
    }
    return 0;
  });
}

/** Get the path tail after the parent branch's fullPath */
function getLeafLabel(item: Child, parentFullPath: string): string {
  if (isRequestGroup(item.doc)) {
    return item.doc.name || 'folder';
  }
  const pathname = extractPathname(item.doc.url || '');
  const prefix = parentFullPath.endsWith('/') ? parentFullPath : parentFullPath + '/';
  if (pathname.startsWith(prefix)) {
    return pathname.slice(prefix.length) || pathname.split('/').filter(Boolean).pop() || '/';
  }
  // fallback: last segment(s)
  return pathname.split('/').filter(Boolean).pop() || '/';
}

/** Recursively collect all request IDs under a node */
function collectRequestIds(node: PathNode): string[] {
  const ids: string[] = [];
  for (const r of node.requests) {
    ids.push(r.doc._id);
  }
  for (const child of node.children) {
    ids.push(...collectRequestIds(child));
  }
  return ids;
}

/** Walk tree in render order to get flat list of request IDs (respecting collapsed state) */
function flattenVisibleIds(nodes: PathNode[], collapsed: Set<string>): string[] {
  const ids: string[] = [];
  for (const node of nodes) {
    const isSingleLeaf = node.children.length === 0 && node.requests.length === 1;
    if (isSingleLeaf) {
      ids.push(node.requests[0].doc._id);
      continue;
    }
    if (!collapsed.has(node.fullPath)) {
      for (const r of sortRequests(node.requests)) {
        ids.push(r.doc._id);
      }
      ids.push(...flattenVisibleIds(node.children, collapsed));
    }
  }
  return ids;
}

interface ProviderUrlTreeProps {
  requests: Child[];
  onSelectRequest: (id: string) => void;
  onDeleteRequests?: (ids: string[]) => void;
}

export const ProviderUrlTree = ({ requests, onSelectRequest, onDeleteRequests }: ProviderUrlTreeProps) => {
  const tree = useMemo(() => buildTree(requests), [requests]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const params = useParams() as { requestId?: string };

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lastClickedId, setLastClickedId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const visibleIds = useMemo(() => flattenVisibleIds(tree, collapsed), [tree, collapsed]);

  const toggleCollapse = (fullPath: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(fullPath)) {
        next.delete(fullPath);
      } else {
        next.add(fullPath);
      }
      return next;
    });
  };

  const handleLeafClick = useCallback((id: string, e: React.MouseEvent) => {
    const isMeta = e.metaKey || e.ctrlKey;
    const isShift = e.shiftKey;

    if (isMeta) {
      // Toggle in selection, no navigate
      setSelectedIds(prev => {
        const next = new Set(prev);
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        return next;
      });
      setLastClickedId(id);
    } else if (isShift && lastClickedId) {
      // Range select
      const fromIdx = visibleIds.indexOf(lastClickedId);
      const toIdx = visibleIds.indexOf(id);
      if (fromIdx !== -1 && toIdx !== -1) {
        const start = Math.min(fromIdx, toIdx);
        const end = Math.max(fromIdx, toIdx);
        const rangeIds = visibleIds.slice(start, end + 1);
        setSelectedIds(new Set(rangeIds));
      }
    } else {
      // Plain click: clear selection, select one, navigate
      setSelectedIds(new Set([id]));
      setLastClickedId(id);
      onSelectRequest(id);
    }
  }, [lastClickedId, visibleIds, onSelectRequest]);

  const handleBranchMetaClick = useCallback((node: PathNode) => {
    const nodeIds = collectRequestIds(node);
    setSelectedIds(prev => {
      const allSelected = nodeIds.every(id => prev.has(id));
      const next = new Set(prev);
      if (allSelected) {
        nodeIds.forEach(id => next.delete(id));
      } else {
        nodeIds.forEach(id => next.add(id));
      }
      return next;
    });
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent, id: string | null, node: PathNode | null) => {
    e.preventDefault();
    // If right-clicked item not in selection, replace selection
    if (id && !selectedIds.has(id)) {
      setSelectedIds(new Set([id]));
      setLastClickedId(id);
    } else if (!id && node) {
      const nodeIds = collectRequestIds(node);
      const anySelected = nodeIds.some(nid => selectedIds.has(nid));
      if (!anySelected) {
        setSelectedIds(new Set(nodeIds));
      }
    }
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, [selectedIds]);

  // Dismiss context menu on escape or click outside
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!contextMenu) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setContextMenu(null);
      }
    };
    const onMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, [contextMenu]);

  const selectedCount = selectedIds.size;

  return (
    <div ref={containerRef} className="relative flex-1 overflow-y-auto py-1 text-[13px]" style={{ fontFamily: 'var(--font-default)' }}>
      {tree.map(node => (
        <TreeNode
          key={node.fullPath}
          node={node}
          level={0}
          collapsed={collapsed}
          onToggle={toggleCollapse}
          onSelectRequest={onSelectRequest}
          selectedRequestId={params.requestId}
          selectedIds={selectedIds}
          onLeafClick={handleLeafClick}
          onBranchMetaClick={handleBranchMetaClick}
          onContextMenu={handleContextMenu}
        />
      ))}

      {/* Context menu */}
      {contextMenu && selectedCount > 0 && onDeleteRequests && (
        <div
          ref={menuRef}
          className="fixed z-50 min-w-[180px] overflow-hidden rounded-md border border-solid border-(--hl-sm) bg-(--color-bg) py-1 shadow-lg"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-(--color-font-danger) hover:bg-(--hl-xs)"
            onClick={() => {
              onDeleteRequests(Array.from(selectedIds));
              setContextMenu(null);
              setSelectedIds(new Set());
            }}
          >
            Delete {selectedCount} endpoint{selectedCount !== 1 ? 's' : ''}
          </button>
        </div>
      )}
    </div>
  );
};

interface TreeNodeProps {
  node: PathNode;
  level: number;
  collapsed: Set<string>;
  onToggle: (fullPath: string) => void;
  onSelectRequest: (id: string) => void;
  selectedRequestId?: string;
  selectedIds: Set<string>;
  onLeafClick: (id: string, e: React.MouseEvent) => void;
  onBranchMetaClick: (node: PathNode) => void;
  onContextMenu: (e: React.MouseEvent, id: string | null, node: PathNode | null) => void;
}

const TreeNode = ({ node, level, collapsed, onToggle, onSelectRequest, selectedRequestId, selectedIds, onLeafClick, onBranchMetaClick, onContextMenu }: TreeNodeProps) => {
  const isCollapsed = collapsed.has(node.fullPath);
  const isSingleLeaf = node.children.length === 0 && node.requests.length === 1;

  // Single-request leaf node: render as one request row, no branch header
  if (isSingleLeaf) {
    const item = node.requests[0];
    return (
      <RequestLeaf
        item={item}
        label={node.segment}
        level={level}
        onLeafClick={onLeafClick}
        isActive={item.doc._id === selectedRequestId}
        isSelected={selectedIds.has(item.doc._id)}
        onContextMenu={e => onContextMenu(e, item.doc._id, null)}
      />
    );
  }

  return (
    <>
      {/* Branch header */}
      <div
        className="flex h-7 w-full cursor-pointer items-center gap-1.5 overflow-hidden pr-2 transition-colors select-none hover:bg-(--hl-xs)"
        style={{ paddingLeft: `${level * 16 + 8}px` }}
        onClick={e => {
          if (e.metaKey || e.ctrlKey) {
            onBranchMetaClick(node);
          } else {
            onToggle(node.fullPath);
          }
        }}
        onContextMenu={e => onContextMenu(e, null, node)}
      >
        <span className="flex w-4 shrink-0 items-center justify-center text-[10px] text-(--hl)">
          {isCollapsed ? '▸' : '▾'}
        </span>
        <span className="font-medium text-(--color-font)">
          {node.segment}
        </span>
        <span className="truncate text-(--hl)" style={{ opacity: 0.5 }}>
          {node.fullPath}/
        </span>
      </div>

      {/* Collapsible contents */}
      {!isCollapsed && (
        <>
          {sortRequests(node.requests).map(item => (
            <RequestLeaf
              key={item.doc._id}
              item={item}
              label={getLeafLabel(item, node.fullPath)}
              level={level + 1}
              onLeafClick={onLeafClick}
              isActive={item.doc._id === selectedRequestId}
              isSelected={selectedIds.has(item.doc._id)}
              onContextMenu={e => onContextMenu(e, item.doc._id, null)}
            />
          ))}
          {node.children.map(child => (
            <TreeNode
              key={child.fullPath}
              node={child}
              level={level + 1}
              collapsed={collapsed}
              onToggle={onToggle}
              onSelectRequest={onSelectRequest}
              selectedRequestId={selectedRequestId}
              selectedIds={selectedIds}
              onLeafClick={onLeafClick}
              onBranchMetaClick={onBranchMetaClick}
              onContextMenu={onContextMenu}
            />
          ))}
        </>
      )}
    </>
  );
};

interface RequestLeafProps {
  item: Child;
  label: string;
  level: number;
  onLeafClick: (id: string, e: React.MouseEvent) => void;
  isActive: boolean;
  isSelected: boolean;
  onContextMenu: (e: React.MouseEvent) => void;
}

const RequestLeaf = ({ item, label, level, onLeafClick, isActive, isSelected, onContextMenu }: RequestLeafProps) => {
  const method = isRequest(item.doc) ? item.doc.method : '';
  const badgeClass = METHOD_BADGE_CLASSES[method] || 'bg-(--hl-md) text-(--color-font)';
  const shortMethod = METHOD_SHORT[method] || method.toUpperCase();

  return (
    <div
      className={`group relative flex h-7 w-full cursor-pointer items-center gap-1.5 overflow-hidden pr-2 transition-colors select-none hover:bg-(--hl-xs) ${isSelected ? 'bg-(--hl-sm)' : ''}`}
      style={{ paddingLeft: `${level * 16 + 8}px` }}
      onClick={e => onLeafClick(item.doc._id, e)}
      onContextMenu={onContextMenu}
    >
      <span
        className={`absolute top-0 left-0 h-full w-[2px] transition-colors ${isActive ? 'bg-(--color-surprise)' : 'bg-transparent'}`}
      />
      {method && (
        <span
          className={`flex w-10 shrink-0 items-center justify-center rounded-xs border border-solid border-(--hl-sm) text-[0.6rem] leading-none ${badgeClass}`}
        >
          {shortMethod}
        </span>
      )}
      <span className={`truncate ${isActive ? 'text-(--color-font)' : 'text-(--color-font)'}`}>
        {label}
      </span>
    </div>
  );
};
