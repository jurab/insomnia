import React, { useMemo, useState } from 'react';
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

interface ProviderUrlTreeProps {
  requests: Child[];
  onSelectRequest: (id: string) => void;
}

export const ProviderUrlTree = ({ requests, onSelectRequest }: ProviderUrlTreeProps) => {
  const tree = useMemo(() => buildTree(requests), [requests]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const params = useParams() as { requestId?: string };

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

  return (
    <div className="flex-1 overflow-y-auto py-1 text-[13px]" style={{ fontFamily: 'var(--font-default)' }}>
      {tree.map(node => (
        <TreeNode
          key={node.fullPath}
          node={node}
          level={0}
          collapsed={collapsed}
          onToggle={toggleCollapse}
          onSelectRequest={onSelectRequest}
          selectedRequestId={params.requestId}
        />
      ))}
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
}

const TreeNode = ({ node, level, collapsed, onToggle, onSelectRequest, selectedRequestId }: TreeNodeProps) => {
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
        onSelect={onSelectRequest}
        isSelected={item.doc._id === selectedRequestId}
      />
    );
  }

  return (
    <>
      {/* Branch header */}
      <div
        className="flex h-7 w-full cursor-pointer items-center gap-1.5 overflow-hidden pr-2 transition-colors select-none hover:bg-(--hl-xs)"
        style={{ paddingLeft: `${level * 16 + 8}px` }}
        onClick={() => onToggle(node.fullPath)}
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
              onSelect={onSelectRequest}
              isSelected={item.doc._id === selectedRequestId}
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
  onSelect: (id: string) => void;
  isSelected: boolean;
}

const RequestLeaf = ({ item, label, level, onSelect, isSelected }: RequestLeafProps) => {
  const method = isRequest(item.doc) ? item.doc.method : '';
  const badgeClass = METHOD_BADGE_CLASSES[method] || 'bg-(--hl-md) text-(--color-font)';
  const shortMethod = METHOD_SHORT[method] || method.toUpperCase();

  return (
    <div
      className={`group relative flex h-7 w-full cursor-pointer items-center gap-1.5 overflow-hidden pr-2 transition-colors select-none hover:bg-(--hl-xs) ${isSelected ? 'bg-(--hl-sm)' : ''}`}
      style={{ paddingLeft: `${level * 16 + 8}px` }}
      onClick={() => onSelect(item.doc._id)}
    >
      <span
        className={`absolute top-0 left-0 h-full w-[2px] transition-colors ${isSelected ? 'bg-(--color-surprise)' : 'bg-transparent'}`}
      />
      {method && (
        <span
          className={`flex w-10 shrink-0 items-center justify-center rounded-xs border border-solid border-(--hl-sm) text-[0.6rem] leading-none ${badgeClass}`}
        >
          {shortMethod}
        </span>
      )}
      <span className={`truncate ${isSelected ? 'text-(--color-font)' : 'text-(--color-font)'}`}>
        {label}
      </span>
    </div>
  );
};
