import { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/db';
import OpenAI from 'openai';
import pdf from 'pdf-parse';
import { Fields, Files, formidable } from 'formidable';
import { createReadStream } from 'fs';

export const config = {
  api: {
    bodyParser: false,
  },
};

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    console.log('[Upload] Starting file upload process');
    
    // Check session
    const session = await getServerSession(req, res, authOptions);
    if (!session?.user) {
      console.log('[Upload] Authentication failed');
      return res.status(401).json({ error: 'Not authenticated' });
    }
    console.log('[Upload] User authenticated:', session.user.id);

    // Parse form data
    console.log('[Upload] Parsing form data');
    const form = formidable();
    const [fields, files] = await new Promise<[Fields, Files]>((resolve, reject) => {
      form.parse(req, (err: Error | null, fields: Fields, files: Files) => {
        if (err) {
          console.error('[Upload] Form parsing error:', err);
          reject(err);
        } else {
          console.log('[Upload] Form parsed successfully');
          resolve([fields, files]);
        }
      });
    });

    const file = files.file?.[0];
    if (!file) {
      console.log('[Upload] No file found in request');
      return res.status(400).json({ error: 'No file provided' });
    }
    console.log('[Upload] File received:', {
      name: file.originalFilename,
      type: file.mimetype,
      size: file.size
    });

    // Extract text from file
    console.log('[Upload] Starting text extraction');
    let textContent: string;
    try {
      if (file.mimetype === 'application/pdf') {
        console.log('[Upload] Processing PDF file');
        const buffer = await new Promise<Buffer>((resolve, reject) => {
          const chunks: Buffer[] = [];
          const stream = createReadStream(file.filepath);
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('error', (err) => {
            console.error('[Upload] PDF read error:', err);
            reject(err);
          });
          stream.on('end', () => {
            console.log('[Upload] PDF read complete, buffer size:', Buffer.concat(chunks).length);
            resolve(Buffer.concat(chunks));
          });
        });

        try {
          const data = await pdf(buffer);
          textContent = data.text;
          console.log('[Upload] PDF text extracted, length:', textContent.length);
          
          if (textContent.length < 1000) {
            console.log('[Upload] Warning: Extracted text is suspiciously short.');
            console.log('[Upload] Extracted content:', textContent);
            throw new Error('The PDF appears to be scanned or have restricted permissions. Please ensure you upload a searchable PDF document.');
          }
        } catch (pdfError) {
          console.error('[Upload] PDF parsing error:', pdfError);
          throw new Error('Failed to parse the PDF. The file might be corrupted, password-protected, or in an unsupported format.');
        }
      } else {
        console.log('[Upload] Processing text file');
        const buffer = await new Promise<Buffer>((resolve, reject) => {
          const chunks: Buffer[] = [];
          const stream = createReadStream(file.filepath);
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('error', (err) => {
            console.error('[Upload] Text file read error:', err);
            reject(err);
          });
          stream.on('end', () => {
            console.log('[Upload] Text file read complete');
            resolve(Buffer.concat(chunks));
          });
        });
        textContent = buffer.toString('utf-8');
        console.log('[Upload] Text file content extracted, length:', textContent.length);
      }

      if (!textContent || textContent.trim().length < 100) {
        console.log('[Upload] No meaningful text content found');
        throw new Error('No meaningful text could be extracted from the file. Please ensure you upload a text-based document, not a scanned image.');
      }
    } catch (error) {
      console.error('[Upload] Text extraction error:', error);
      return res.status(400).json({ 
        error: error instanceof Error ? error.message : 'Failed to extract text from the file. Please ensure the file is not corrupted and try again.'
      });
    }

    // Analyze with OpenAI
    console.log('[Upload] Starting OpenAI analysis');
    const maxChunkSize = 12000;
    const chunks = [];
    
    // Split text into chunks
    for (let i = 0; i < textContent.length; i += maxChunkSize) {
      chunks.push(textContent.slice(i, i + maxChunkSize));
    }
    console.log('[Upload] Split text into', chunks.length, 'chunks');

    // Analyze each chunk
    console.log('[Upload] Analyzing chunks with OpenAI');
    const chunkAnalyses = await Promise.all(chunks.map(async (chunk, index) => {
      try {
        console.log(`[Upload] Analyzing chunk ${index + 1}/${chunks.length}`);
        const aiResponse = await openai.chat.completions.create({
          model: 'gpt-4-turbo-preview',
          messages: [
            {
              role: 'system',
              content: `You are an expert contract analyst with deep knowledge of legal documents, particularly property contracts. Analyze the provided contract segment and provide a structured analysis. Pay special attention to financial terms and property values. Return a JSON object with the following structure:

{
  "keyInsights": {
    "summary": "Brief one-line summary of the contract type and main purpose",
    "points": [
      // 4-5 most important aspects of the contract, focusing on:
      // - Critical dates and deadlines
      // - Key conditions and dependencies
      // - Financial implications
      // - Legal requirements
      // - Important clauses
    ]
  },
  "potentialIssues": {
    "summary": "Brief overview of main risk areas",
    "points": [
      // 4-5 key risks or concerns, focusing on:
      // - Timing risks
      // - Financial risks
      // - Legal complications
      // - Compliance challenges
      // - Performance risks
    ]
  },
  "recommendations": {
    "summary": "Key actions needed",
    "points": [
      // 4-5 actionable recommendations, focusing on:
      // - Immediate actions needed
      // - Risk mitigation steps
      // - Compliance requirements
      // - Due diligence suggestions
      // - Timeline management
    ]
  },
  "financialTerms": {
    "propertyValue": "Extract the exact property value/purchase price. Include the currency symbol. If not found, use 'Not specified'",
    "paymentSchedule": "Extract payment terms, deposit amounts, and due dates. If not found, use 'Not specified'",
    "additionalCosts": [
      // List all additional costs mentioned:
      // - Stamp duty
      // - Registration fees
      // - Agent commissions
      // - Legal fees
      // - Other charges
    ],
    "financialConditions": [
      // List all financial conditions:
      // - Finance approval requirements
      // - Deposit conditions
      // - Payment milestones
      // - Financial contingencies
    ]
  }
}`
            },
            {
              role: 'user',
              content: `Analyze this contract segment and provide detailed insights. Focus on meaningful analysis rather than just listing parties: ${chunk}`
            }
          ],
          temperature: 0,
          response_format: { type: "json_object" }
        });
        console.log(`[Upload] Chunk ${index + 1} analysis complete`);
        return JSON.parse(aiResponse.choices[0].message.content || '{}');
      } catch (error) {
        console.error(`[Upload] Error analyzing chunk ${index + 1}:`, error);
        throw new Error(`Failed to analyze contract segment ${index + 1}`);
      }
    }));

    // Merge analyses from all chunks
    console.log('[Upload] Merging analyses from all chunks');
    const mergedAnalysis = {
      keyInsights: {
        summary: chunkAnalyses.find(a => a.keyInsights?.summary)?.keyInsights.summary || null,
        points: [...new Set(chunkAnalyses.flatMap(a => a.keyInsights?.points || []))]
      },
      potentialIssues: {
        summary: chunkAnalyses.find(a => a.potentialIssues?.summary)?.potentialIssues.summary || null,
        points: [...new Set(chunkAnalyses.flatMap(a => a.potentialIssues?.points || []))]
      },
      recommendations: {
        summary: chunkAnalyses.find(a => a.recommendations?.summary)?.recommendations.summary || null,
        points: [...new Set(chunkAnalyses.flatMap(a => a.recommendations?.points || []))]
      },
      financialTerms: {
        propertyValue: chunkAnalyses.reduce((value, chunk) => {
          if (chunk.financialTerms?.propertyValue && 
              chunk.financialTerms.propertyValue !== 'Not specified' && 
              chunk.financialTerms.propertyValue !== 'null') {
            return chunk.financialTerms.propertyValue;
          }
          return value;
        }, 'Not specified'),
        paymentSchedule: chunkAnalyses.reduce((schedule, chunk) => {
          if (chunk.financialTerms?.paymentSchedule && 
              chunk.financialTerms.paymentSchedule !== 'Not specified' && 
              chunk.financialTerms.paymentSchedule !== 'null') {
            return chunk.financialTerms.paymentSchedule;
          }
          return schedule;
        }, 'Not specified'),
        additionalCosts: [...new Set(chunkAnalyses.flatMap(a => a.financialTerms?.additionalCosts || []))],
        financialConditions: [...new Set(chunkAnalyses.flatMap(a => a.financialTerms?.financialConditions || []))]
      }
    };

    // Save to database
    console.log('[Upload] Saving to database');
    await prisma.contract.create({
      data: {
        name: file.originalFilename || 'Untitled Contract',
        content: textContent,
        userId: session.user.id,
        status: 'analyzed',
        fileType: file.mimetype || 'text/plain',
        analysis: mergedAnalysis
      }
    });
    console.log('[Upload] Database save complete');

    console.log('[Upload] Process complete, sending response');
    return res.status(200).json({
      message: 'File processed successfully',
      analysis: mergedAnalysis,
      fileName: file.originalFilename,
      fileType: file.mimetype
    });
  } catch (error) {
    console.error('[Upload] Error processing request:', error);
    return res.status(500).json({ 
      error: error instanceof Error ? error.message : 'An error occurred'
    });
  }
} 