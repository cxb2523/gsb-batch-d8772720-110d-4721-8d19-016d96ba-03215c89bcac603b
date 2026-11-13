import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { CollectionOutcomePanel } from './CollectionOutcomePanel';
import type { CollectionOutcome } from '../tracker.types';

const outcomeWithFailures: CollectionOutcome = {
  queryOutcomes: [
    { query: 'react performance tips', success: true, postCount: 5 },
    { query: 'broken query', success: false, postCount: 0, error: 'Network timeout' },
    { query: 'react hooks', success: true, postCount: 0 },
  ],
  totalQueries: 3,
  successfulQueries: 2,
  failedQueries: 1,
  selectedPostCount: 5,
};

const outcomeAllSuccess: CollectionOutcome = {
  queryOutcomes: [
    { query: 'react performance tips', success: true, postCount: 3 },
    { query: 'react hooks', success: true, postCount: 2 },
  ],
  totalQueries: 2,
  successfulQueries: 2,
  failedQueries: 0,
  selectedPostCount: 4,
};

describe('CollectionOutcomePanel', () => {
  describe('with failed queries', () => {
    it('renders the prominent partial-failure banner', () => {
      render(<CollectionOutcomePanel outcome={outcomeWithFailures} />);

      expect(screen.getByText('部分查询失败')).toBeInTheDocument();
    });

    it('lists each failed query together with its error reason', () => {
      render(<CollectionOutcomePanel outcome={outcomeWithFailures} />);

      expect(screen.getByText('"broken query"')).toBeInTheDocument();
      expect(screen.getByText('Network timeout')).toBeInTheDocument();
    });

    it('does not list successful queries as failures', () => {
      render(<CollectionOutcomePanel outcome={outcomeWithFailures} />);

      // Successful query text must not appear in the failure list
      expect(screen.queryByText('"react performance tips"')).not.toBeInTheDocument();
      expect(screen.queryByText('"react hooks"')).not.toBeInTheDocument();
    });

    it('shows the roll-up totals', () => {
      render(<CollectionOutcomePanel outcome={outcomeWithFailures} />);

      expect(screen.getByText(/计划查询 3/)).toBeInTheDocument();
      expect(screen.getByText(/成功 2/)).toBeInTheDocument();
      expect(screen.getByText(/失败 1/)).toBeInTheDocument();
      expect(screen.getByText(/入选帖子 5/)).toBeInTheDocument();
    });

    it('warns that conclusions may be incomplete', () => {
      render(<CollectionOutcomePanel outcome={outcomeWithFailures} />);

      expect(screen.getByText(/以下结论仅基于成功采集的查询结果/)).toBeInTheDocument();
    });
  });

  describe('with all queries successful', () => {
    it('renders the short success summary instead of a failure banner', () => {
      render(<CollectionOutcomePanel outcome={outcomeAllSuccess} />);

      expect(screen.getByText('全部查询采集成功')).toBeInTheDocument();
      expect(screen.queryByText('部分查询失败')).not.toBeInTheDocument();
    });

    it('summarizes query count and selected post count', () => {
      render(<CollectionOutcomePanel outcome={outcomeAllSuccess} />);

      expect(screen.getByText(/2 个查询全部成功/)).toBeInTheDocument();
      expect(screen.getByText(/共 4 篇帖子入选报告/)).toBeInTheDocument();
    });

    it('does not render the failed-query section', () => {
      render(<CollectionOutcomePanel outcome={outcomeAllSuccess} />);

      expect(screen.queryByText('失败的查询：')).not.toBeInTheDocument();
    });
  });
});
