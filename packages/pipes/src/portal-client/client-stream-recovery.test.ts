import { describe, expect, vi } from 'vitest'

import { MalformedPortalResponseError } from '~/core/errors.js'
import { defaultLogger } from '~/core/logger.js'
import { PortalBlockStreamOptions, PortalClient } from '~/portal-client/client.js'
import { MockResponse } from '~/testing/index.js'
import { withPortal } from '~/testing/portal-fixture.js'

const query = {
  type: 'evm',
  fromBlock: 0,
  toBlock: 3,
  fields: { block: { number: true, hash: true } },
} as any

// A range over the mock chain: with `includeAllBlocks` every number in it is delivered.
const range = { ...query, fromBlock: 1, toBlock: 5, includeAllBlocks: true }

function block(number: number) {
  return { header: { number, hash: `0x${number}` } }
}

/** The block numbers the stream delivered, and the error it ended with, if any. */
async function readUntilError(client: PortalClient, options?: PortalBlockStreamOptions) {
  const delivered: number[] = []
  try {
    for await (const batch of client.getStream(range, options)) {
      delivered.push(...batch.blocks.map((b: any) => b.header.number))
    }
  } catch (error) {
    return { delivered, error: error as Error }
  }

  return { delivered, error: undefined }
}

describe('PortalClient truncated response', () => {
  // Scenario 1: the body ends inside a block's JSON — a truncation, not bad data. The stream
  // re-requests from the block the body ended inside of and delivers every block once.
  withPortal(
    're-requests from the cut block when the body ends mid-line, without failing',
    async ({ portal: open }) => {
      const portal = await open({ latest: 5 })
      portal.fail({ cutAfter: 2 })

      const logger = defaultLogger({ level: 'silent' })
      const warn = vi.spyOn(logger, 'warn')

      const { delivered, error } = await readUntilError(new PortalClient({ url: portal.url, logger }))

      expect(error).toBeUndefined()
      expect(delivered).toEqual([1, 2, 3, 4, 5])
      // The second request starts at the block the first response ended inside of.
      expect(portal.requests.map((r) => [r.query.fromBlock, r.answer?.kind])).toEqual([
        [1, 'cut'],
        [3, 'blocks'],
      ])
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: 'portal response ended inside a block, requesting again from block 3' }),
      )
    },
  )

  // Scenario 2: a second cut at the same fromBlock is the portal's data, not the transport —
  // the caller sees it as `cut-twice`, distinct from a recoverable truncation.
  withPortal('fails with cut-twice when the same fromBlock is cut twice in a row', async ({ portal: open }) => {
    const portal = await open({ latest: 5 })
    portal.fail({ cutAfter: 2 })
    portal.fail({ cutAfter: 0 })

    const { delivered, error } = await readUntilError(new PortalClient({ url: portal.url }))

    expect(error).toBeInstanceOf(MalformedPortalResponseError)
    expect((error as MalformedPortalResponseError).problem).toBe('cut-twice')
    expect((error as MalformedPortalResponseError).fromBlock).toBe(3)
    // Only the blocks delivered before the first cut reached the consumer.
    expect(delivered).toEqual([1, 2].slice(0, delivered.length))
  })
})

describe('PortalClient malformed line', () => {
  // Scenario 3a: a newline-terminated line that does not parse is malformed data, not a cut.
  withPortal('reports invalid-json for a newline-ended line that does not parse', async ({ portal: open }) => {
    const portal = await open({ latest: 5 })
    portal.fail({ lineAfter: 2, line: '{"header": nope' })

    const { delivered, error } = await readUntilError(new PortalClient({ url: portal.url }))

    expect(error).toBeInstanceOf(MalformedPortalResponseError)
    expect((error as MalformedPortalResponseError).problem).toBe('invalid-json')
    expect((error as MalformedPortalResponseError).fromBlock).toBe(3)
    expect(delivered).toEqual([1, 2].slice(0, delivered.length))
    // A malformed line is not re-requested: the stream stops at the first bad response.
    expect(portal.requests).toHaveLength(1)
  })

  // Scenario 3b: valid JSON without a safe-integer `header.number` is malformed too.
  withPortal('reports no-block-number for a line without a valid header.number', async ({ portal: open }) => {
    const portal = await open({ latest: 5 })
    portal.fail({ lineAfter: 0, line: '{"header":{"hash":"0x1"}}' })

    const { delivered, error } = await readUntilError(new PortalClient({ url: portal.url }))

    expect(error).toBeInstanceOf(MalformedPortalResponseError)
    expect((error as MalformedPortalResponseError).problem).toBe('no-block-number')
    expect((error as MalformedPortalResponseError).fromBlock).toBe(1)
    expect(delivered).toEqual([])
  })
})

describe('PortalClient stalled response', () => {
  // Scenario 4: the body goes silent past the body timeout — the stream cuts the response,
  // reports the stall, and continues from the current fromBlock instead of ending.
  withPortal(
    'resumes from the current fromBlock after a body timeout, without ending the stream',
    async ({ portal: open }) => {
      const portal = await open({ latest: 5 })
      portal.fail({ stallAfter: 2 })

      const logger = defaultLogger({ level: 'silent' })
      const warn = vi.spyOn(logger, 'warn')
      const client = new PortalClient({ url: portal.url, logger })

      const { delivered, error } = await readUntilError(client, { request: { bodyTimeout: 100 } })

      expect(error).toBeUndefined()
      expect(delivered).toEqual([1, 2, 3, 4, 5])
      // The stall happened after block 2, so the follow-up request starts at block 3.
      expect(portal.requests.map((r) => [r.query.fromBlock, r.answer?.kind])).toEqual([
        [1, 'stalled'],
        [3, 'blocks'],
      ])
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          message: expect.stringMatching(/^portal response stalled: no block for \d+s, requesting again from block 3$/),
          fromBlock: 3,
        }),
      )
    },
  )
})

describe('PortalClient head poll accounting', () => {
  // Scenario 5: a 204 carries no blocks, but its status count is not dropped — it reaches the
  // meta.requests of the batch delivered right after it, and the next data batch counts its own 200.
  withPortal(
    'carries the status count of a 204 into the meta.requests of the batch that follows it',
    async ({ portal: open }) => {
      const portal = await open([
        { statusCode: 204 },
        {
          statusCode: 200,
          data: [block(1), block(2), block(3)],
          head: { finalized: { number: 3, hash: '0x3' } },
        },
      ] satisfies MockResponse[])

      const client = new PortalClient({ url: portal.url })

      const batches: { blocks: number[]; requests: Record<number, number> }[] = []
      for await (const batch of client.getStream(query)) {
        batches.push({ blocks: batch.blocks.map((b: any) => b.header.number), requests: batch.meta.requests })
      }

      expect(batches).toEqual([
        { blocks: [], requests: { 204: 1 } },
        { blocks: [1, 2, 3], requests: { 200: 1 } },
      ])
    },
  )
})
