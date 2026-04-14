import type Database from 'better-sqlite3';
import type { ProjectConfig } from '../../config.js';
import type { ToolResponse } from './providers/base.js';
import { ok, fail } from './providers/base.js';

export interface KeywordCluster {
  clusterId: number;
  name: string;
  primaryKeyword: string;
  intent: string;
  keywords: string[];
}

export async function clusterKeywords(
  keywords: string[],
  config: ProjectConfig,
  db: Database.Database
): Promise<ToolResponse<KeywordCluster[]>> {
  if (keywords.length === 0) {
    return fail<KeywordCluster[]>('EMPTY_INPUT', 'No keywords provided', 'Provide at least one keyword to cluster');
  }

  // Simple clustering by shared terms (no LLM needed for basic version)
  // TODO: Add LLM-based clustering with Anthropic SDK in Phase 2
  const clusters = simpleCluster(keywords);

  // Save clusters to DB
  const insertCluster = db.prepare(
    `INSERT INTO keyword_clusters (project_id, name, primary_keyword, intent)
     VALUES (?, ?, ?, ?)`
  );
  const updateKeyword = db.prepare(
    `UPDATE keywords SET cluster_id = ? WHERE project_id = ? AND keyword = ?`
  );

  const txn = db.transaction((cls: KeywordCluster[]) => {
    for (const c of cls) {
      const result = insertCluster.run(
        config.projectId,
        c.name,
        c.primaryKeyword,
        c.intent
      );
      const clusterId = result.lastInsertRowid as number;
      for (const kw of c.keywords) {
        updateKeyword.run(clusterId, config.projectId, kw);
      }
    }
  });

  txn(clusters);

  return ok(clusters);
}

function simpleCluster(keywords: string[]): KeywordCluster[] {
  // Group keywords that share significant terms
  const groups: Map<string, string[]> = new Map();

  for (const kw of keywords) {
    const terms = kw
      .toLowerCase()
      .split(/[\s,]+/)
      .filter((t) => t.length > 1);
    const key = terms.sort().join(' ');

    // Try to find an existing group with overlapping terms
    let placed = false;
    for (const [groupKey, members] of groups) {
      const groupTerms = new Set(groupKey.split(' '));
      const overlap = terms.filter((t) => groupTerms.has(t));
      if (overlap.length > 0) {
        members.push(kw);
        placed = true;
        break;
      }
    }

    if (!placed) {
      groups.set(key, [kw]);
    }
  }

  let id = 1;
  const clusters: KeywordCluster[] = [];
  for (const [, members] of groups) {
    clusters.push({
      clusterId: id++,
      name: members[0],
      primaryKeyword: members[0],
      intent: 'informational', // Default; LLM will classify later
      keywords: members,
    });
  }

  return clusters;
}
