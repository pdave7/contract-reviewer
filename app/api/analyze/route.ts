import { NextResponse } from 'next/server';
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function POST(req: Request) {
  try {
    const { content } = await req.json();

    // First analysis: Get summary
    const summaryResponse = await openai.chat.completions.create({
      model: "gpt-4-turbo-preview",
      messages: [
        {
          role: "system",
          content: "You are a document analyst specializing in contract review."
        },
        {
          role: "user",
          content: "Summarize the key points from this document chunk in 100 words:\n\n" + content
        }
      ],
    });

    const summary = summaryResponse.choices[0].message.content;
    if (!summary) {
      throw new Error('Failed to generate summary');
    }

    // Second analysis: Get detailed analysis in JSON format
    const analysisResponse = await openai.chat.completions.create({
      model: "gpt-4-turbo-preview",
      messages: [
        {
          role: "system",
          content: "You are a document analyst. Provide analysis in JSON format."
        },
        {
          role: "user",
          content: "Based on the aggregated summaries of the document, provide an overall analysis. Highlight key insights, potential issues, and recommendations in JSON format with keys: 'keyInsights', 'potentialIssues', and 'recommendations'.\n\n" + summary
        }
      ],
    });

    const analysisContent = analysisResponse.choices[0].message.content;
    if (!analysisContent) {
      throw new Error('Failed to generate analysis');
    }

    return NextResponse.json({ 
      success: true, 
      summary,
      analysis: JSON.parse(analysisContent)
    });

  } catch (error) {
    console.error('Error processing document:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to process document' },
      { status: 500 }
    );
  }
} 