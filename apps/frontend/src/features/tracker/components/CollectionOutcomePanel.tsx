import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { CollectionOutcome, QueryOutcome } from '../tracker.types';

interface CollectionOutcomePanelProps {
  outcome: CollectionOutcome;
}

const QueryRow = ({ item }: { item: QueryOutcome }) => (
  <li className="flex items-start gap-2 py-1.5">
    {item.success ? (
      <CheckCircle2
        data-testid="query-success-icon"
        className="mt-0.5 h-4 w-4 shrink-0 text-green-600 dark:text-green-400"
      />
    ) : (
      <XCircle
        data-testid="query-failure-icon"
        className="mt-0.5 h-4 w-4 shrink-0 text-destructive"
      />
    )}
    <div className="min-w-0 flex-1">
      <p className="text-sm font-medium break-words">"{item.query}"</p>
      {item.success ? (
        <p className="text-xs text-muted-foreground">
          {item.postCount} {item.postCount === 1 ? 'post' : 'posts'} collected
        </p>
      ) : (
        <p className="text-xs text-destructive break-words">{item.error ?? 'Unknown error'}</p>
      )}
    </div>
  </li>
);

/**
 * Renders the collection outcome of an analysis run alongside the report body.
 * When any query failed it shows a prominent "部分查询失败" banner plus every
 * failed query and its reason; otherwise it collapses to a short success
 * summary. Used by both the live report page and the history detail page.
 */
export const CollectionOutcomePanel = ({ outcome }: CollectionOutcomePanelProps) => {
  const hasFailures = outcome.failedQueries > 0;
  const failedOutcomes = outcome.queryOutcomes.filter((q) => !q.success);

  if (hasFailures) {
    return (
      <Card
        data-testid="collection-outcome-panel"
        className="border-destructive/40 bg-destructive/5"
      >
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base text-destructive">
            <AlertTriangle className="h-4 w-4" />
            部分查询失败
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge variant="secondary">计划查询 {outcome.totalQueries}</Badge>
            <Badge
              variant="secondary"
              className="bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400"
            >
              成功 {outcome.successfulQueries}
            </Badge>
            <Badge variant="secondary" className="bg-destructive/10 text-destructive">
              失败 {outcome.failedQueries}
            </Badge>
            <Badge variant="secondary">入选帖子 {outcome.selectedPostCount}</Badge>
          </div>

          <div>
            <p className="text-sm font-medium mb-1">失败的查询：</p>
            <ul className="divide-y divide-border/60">
              {failedOutcomes.map((item) => (
                <QueryRow key={item.query} item={item} />
              ))}
            </ul>
          </div>

          <p className="text-xs text-muted-foreground">
            以下结论仅基于成功采集的查询结果，缺失查询可能影响结论的完整性。
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="collection-outcome-panel" className="border-green-500/30 bg-green-500/5">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
          全部查询采集成功
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          {outcome.successfulQueries} 个查询全部成功，共 {outcome.selectedPostCount}{' '}
          篇帖子入选报告。
        </p>
      </CardContent>
    </Card>
  );
};
