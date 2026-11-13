import { NextRequest, NextResponse } from 'next/server';

async function getPuppeteerQueue() {
  try {
    const { puppeteerQueue } = await import('./queue');
    return puppeteerQueue;
  } catch {
    return null;
  }
}

const PUPPETEER_UNAVAILABLE = {
  success: false,
  error: 'Puppeteer is not available on this deployment. The /api/puppeteer route requires a Node.js runtime with Chromium installed.',
};

// Configure runtime for larger payloads
export const runtime = 'nodejs';
export const maxDuration = 300; // 5 minutes max

// CORS headers for cross-origin requests
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

interface PuppeteerRequest {
  code: string;
  config: {
    timeout: number;
    headless: boolean;
  };
  rowData: Record<string, string>;
}

export async function POST(request: NextRequest) {
  try {
    console.log('📨 Received Puppeteer job request');

    // Handle large payloads (up to 10MB)
    const body: PuppeteerRequest = await request.json();
    const { code, config, rowData } = body;

    // Enhanced validation
    if (!code || !code.trim()) {
      return NextResponse.json(
        { success: false, error: 'No Puppeteer code provided' },
        { status: 400, headers: corsHeaders }
      );
    }

    // Check code length (max 50KB) - DISABLED FOR TESTING
    // if (code.length > 50000) {
    //   return NextResponse.json(
    //     { success: false, error: 'Code is too long (max 50KB)' },
    //     { status: 400, headers: corsHeaders }
    //   );
    // }

    // Check for dangerous patterns - DISABLED FOR TESTING
    // const dangerousPatterns = [
    //   /require\s*\([^)]*['"]fs['"]/,
    //   /require\s*\([^)]*['"]child_process['"]/,
    //   /require\s*\([^)]*['"]os['"]/,
    //   /process\s*\./,
    //   /__dirname/,
    //   /__filename/,
    //   /eval\s*\(/,
    //   /Function\s*\(/
    // ];

    // for (const pattern of dangerousPatterns) {
    //   if (pattern.test(code)) {
    //     return NextResponse.json(
    //       { success: false, error: 'Code contains potentially dangerous operations' },
    //       { status: 400, headers: corsHeaders }
    //     );
    //   }
    // }

    if (!config || typeof config.timeout !== 'number' || typeof config.headless !== 'boolean') {
      return NextResponse.json(
        { success: false, error: 'Invalid configuration provided' },
        { status: 400, headers: corsHeaders }
      );
    }

    // Sanitize timeout (5s min, 120s max for complex operations)
    const sanitizedConfig = {
      ...config,
      timeout: Math.max(5000, Math.min(config.timeout, 120000))
    };

    console.log('📝 Code length:', code.length);
    console.log('⚙️ Config:', sanitizedConfig);
    console.log('📊 Row data keys:', Object.keys(rowData || {}));

    const puppeteerQueue = await getPuppeteerQueue();
    if (!puppeteerQueue) {
      return NextResponse.json(PUPPETEER_UNAVAILABLE, { status: 503, headers: corsHeaders });
    }

    // Fix #2: Queue size cap — prevent unbounded growth (OOM protection)
    const currentStats = puppeteerQueue.getQueueStats();
    if (currentStats.pending >= 1000) {
      console.warn(`⚠️ Queue full: ${currentStats.pending} pending jobs. Rejecting new job.`);
      return NextResponse.json(
        {
          success: false,
          error: 'Queue is full (1000 pending jobs). Please wait for current jobs to complete before submitting more.',
          queueStats: currentStats
        },
        { status: 429, headers: corsHeaders }
      );
    }

    // Add job to queue (immediate response)
    const jobId = puppeteerQueue.addJob({
      code,
      config: sanitizedConfig,
      rowData: rowData || {}
    });

    console.log(`✅ Job ${jobId} queued successfully`);

    return NextResponse.json({
      queued: true,
      jobId,
      message: 'Job added to queue successfully',
      estimatedWaitTime: puppeteerQueue.getQueueStats().estimatedWaitTime,
      queuePosition: puppeteerQueue.getQueueStats().pending + 1
    }, { headers: corsHeaders });

  } catch (error) {
    console.error('💥 Puppeteer API error:', error);

    // Handle specific error types
    if (error instanceof SyntaxError) {
      return NextResponse.json(
        {
          success: false,
          error: 'Invalid JSON in request body'
        },
        { status: 400, headers: corsHeaders }
      );
    }

    const errorMessage = error instanceof Error ? error.message : 'Unknown server error';

    // Log error details for debugging
    console.error('Error details:', {
      message: errorMessage,
      stack: error instanceof Error ? error.stack : undefined,
      timestamp: new Date().toISOString()
    });

    return NextResponse.json(
      {
        success: false,
        error: `Server error: ${errorMessage}`,
        timestamp: new Date().toISOString()
      },
      { status: 500, headers: corsHeaders }
    );
  }
}

export async function GET() {
  const puppeteerQueue = await getPuppeteerQueue();
  if (!puppeteerQueue) {
    return NextResponse.json(PUPPETEER_UNAVAILABLE, { status: 503, headers: corsHeaders });
  }
  // Return queue statistics
  const stats = puppeteerQueue.getQueueStats();
  const recentJobs = puppeteerQueue.getRecentJobs(5);
  const cancelled = puppeteerQueue.getCancelledJobs(10);

  return NextResponse.json({
    queue: stats,
    recentJobs,
    cancelled,
    message: 'Puppeteer queue status'
  }, { headers: corsHeaders });
}

// Cancel a queued job. Only jobs still in 'pending' state can be cancelled;
// once execution has started (or the job finished) the request is rejected.
export async function DELETE(request: NextRequest) {
  try {
    const requestUrl = new URL(request.url);
    const jobId = requestUrl.searchParams.get('jobId')?.trim();

    if (!jobId) {
      return NextResponse.json(
        { success: false, error: 'jobId query parameter is required' },
        { status: 400, headers: corsHeaders }
      );
    }

    const puppeteerQueue = await getPuppeteerQueue();
    if (!puppeteerQueue) {
      return NextResponse.json(PUPPETEER_UNAVAILABLE, { status: 503, headers: corsHeaders });
    }

    const outcome = puppeteerQueue.cancelJob(jobId);

    if (outcome === 'not-found') {
      return NextResponse.json(
        {
          success: false,
          error: 'Job not found',
          jobId,
          message: 'The requested job does not exist, has already been cancelled, or has expired'
        },
        { status: 404, headers: corsHeaders }
      );
    }

    if (outcome === 'not-cancellable') {
      const job = puppeteerQueue.getJob(jobId);
      return NextResponse.json(
        {
          success: false,
          error: 'Job cannot be cancelled',
          jobId,
          status: job?.status,
          message: 'Only jobs that are still pending in the queue can be cancelled. This job has already started or finished.'
        },
        { status: 409, headers: corsHeaders }
      );
    }

    console.log(`🛑 Job ${jobId} cancelled via DELETE /api/puppeteer`);

    return NextResponse.json({
      success: true,
      jobId,
      status: 'cancelled'
    }, { headers: corsHeaders });

  } catch (error) {
    console.error('💥 Puppeteer cancel API error:', error);

    const errorMessage = error instanceof Error ? error.message : 'Unknown server error';

    return NextResponse.json(
      {
        success: false,
        error: `Server error: ${errorMessage}`,
        timestamp: new Date().toISOString()
      },
      { status: 500, headers: corsHeaders }
    );
  }
}

// Handle CORS preflight requests
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 200,
    headers: corsHeaders
  });
}