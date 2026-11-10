import { readOutgoingJson, checkBytes, outgoingLimits, OutgoingInputError } from '@/lib/email/outgoing-budget';
import { z } from 'zod';
import { NextRequest, NextResponse } from 'next/server';
import { AiAccessError, AiUnavailableError, callLlmApi } from '@/lib/ai/llm-client';
import { extractCleanEmailText } from '@/lib/email/clean-text';
import { authenticate } from '@/lib/auth/middleware';
import { assertAccountContextAccess } from '@/lib/accounts/access';

export async function POST(req: Request) {
  const auth = await authenticate(req as NextRequest);
  if (auth instanceof Response) return auth;

  try {
    const body = z.object({
      accountId: z.string().optional(), emailId: z.string().optional(),
      prompt: z.string().optional(), existingText: z.string().optional(),
      tone: z.string().optional(), length: z.string().optional(), action: z.string().optional(),
      replyContext: z.object({ subject: z.string().optional(), body: z.string().optional() }).optional(),
    }).safeParse(await readOutgoingJson(req));
    if (!body.success) return NextResponse.json({ error: 'Invalid draft arguments' }, { status: 422 });
    const limits = outgoingLimits();
    for (const value of [body.data.prompt, body.data.existingText, body.data.replyContext?.body]) checkBytes(value, limits.bodyBytes, 'Draft text');
    for (const value of [body.data.accountId, body.data.emailId, body.data.tone, body.data.length, body.data.action]) checkBytes(value, limits.argumentBytes, 'Draft argument');
    checkBytes(body.data.replyContext?.subject, limits.headerBytes, 'Subject');
    const {
      accountId,
      emailId,
      prompt,
      tone = 'Professional',
      length = 'Medium',
      action = 'generate',
      existingText,
      replyContext,
    } = body.data;

    if (!prompt && !existingText) {
      return NextResponse.json({ error: 'Prompt or existing text is required' }, { status: 400 });
    }

    const account = await assertAccountContextAccess(auth, { accountId, emailId });
    if (account instanceof Response) return account;

    let systemInstruction = `You are an expert AI email assistant. Generate email draft content based on user requirements.
Tone: ${tone}. Target Length: ${length}.
Respond ONLY with the email subject line (if applicable) and body content. Do not include introductory conversational filler like "Here is your email:".`;

    let userPrompt = '';

    if (action === 'rewrite' || action === 'proofread' || action === 'expand' || action === 'shorten') {
      systemInstruction += `\nYour task is to ${action} the user's provided text while matching tone ${tone} and length ${length}.`;
      const cleanedExistingText = extractCleanEmailText(existingText, { maxLength: 4000 });
      userPrompt = `Text to modify:\n"""\n${cleanedExistingText}\n"""\nInstructions: ${prompt || action}`;
    } else {
      if (replyContext) {
        const cleanedReplyBody = extractCleanEmailText(replyContext.body, { maxLength: 4000 });
        userPrompt += `Replying to email subject: "${replyContext.subject || ''}"\nOriginal Email Snippet:\n"""\n${cleanedReplyBody}\n"""\n\n`;
      }
      userPrompt += `Draft an email with the following request:\n${prompt}`;
    }

    const resultText = await callLlmApi({
      organizationId: auth.organizationId,
      userId: auth.userId,
      systemInstruction,
      userPrompt,
    });

    return NextResponse.json({ result: resultText, status: 'success' });
  } catch (err: any) {
    if (err instanceof OutgoingInputError) return NextResponse.json({ error: err.message }, { status: err.status });
    if (err instanceof AiUnavailableError) {
      return NextResponse.json({ error: err.message, reason: err.reason }, { status: 503 });
    }
    if (err instanceof AiAccessError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    console.error('AI Draft Route Error:', err);
    return NextResponse.json({ error: err.message || 'Failed to generate AI draft' }, { status: 500 });
  }
}
