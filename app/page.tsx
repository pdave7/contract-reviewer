'use client';

import { useState } from 'react';
import { useDropzone } from 'react-dropzone';

interface Analysis {
  keyInsights: string[];
  potentialIssues: string[];
  recommendations: string[];
}

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState('');
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [progress, setProgress] = useState(0);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: (acceptedFiles) => {
      const selectedFile = acceptedFiles[0];
      if (selectedFile.size > 100 * 1024 * 1024) { // 100MB
        setError('File size must be less than 100MB');
        return;
      }
      setFile(selectedFile);
      setError('');
      setStatus('');
      setProgress(0);
    },
    maxFiles: 1,
    multiple: false,
    accept: {
      'text/*': ['.txt', '.md', '.doc', '.docx', '.pdf'],
      'application/pdf': ['.pdf'],
      'application/msword': ['.doc'],
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx']
    }
  });

  const handleReview = async () => {
    if (!file) return;

    setLoading(true);
    setError('');
    setStatus('Reading file...');
    setProgress(0);
    
    try {
      const reader = new FileReader();
      reader.onload = async (e) => {
        const text = e.target?.result as string;
        setStatus('Initializing analysis...');
        
        try {
          const response = await fetch('/api/analyze', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ content: text }),
          });

          if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
          }

          const reader = response.body?.getReader();
          if (!reader) {
            throw new Error('No reader available');
          }

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            // Convert the chunk to text and split by newlines
            const chunk = new TextDecoder().decode(value);
            const lines = chunk.split('\n').filter(line => line.trim());

            // Process each line
            for (const line of lines) {
              try {
                const data = JSON.parse(line);
                switch (data.type) {
                  case 'status':
                    setStatus(data.message);
                    break;
                  case 'progress':
                    setStatus(data.message);
                    setProgress(data.progress);
                    break;
                  case 'complete':
                    setSummary(data.summary);
                    setAnalysis(data.analysis);
                    setStatus('Analysis complete!');
                    setProgress(100);
                    break;
                  case 'error':
                    setError(data.message);
                    setStatus('');
                    break;
                }
              } catch (e) {
                console.error('Error parsing stream chunk:', e);
              }
            }
          }
        } catch (error) {
          setError('Failed to analyze document: ' + (error instanceof Error ? error.message : 'Unknown error'));
          setStatus('');
        }
        setLoading(false);
      };

      reader.onerror = () => {
        setError('Failed to read the file. Please try again.');
        setStatus('');
        setLoading(false);
      };

      reader.readAsText(file);
    } catch (error) {
      setError('Error processing file: ' + (error instanceof Error ? error.message : 'Unknown error'));
      setStatus('');
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <div className="w-64 bg-gray-100 p-6">
        <h2 className="text-xl font-bold mb-4">Contract Reviewer</h2>
        <p className="text-sm text-gray-600">
          Drop your contract file to get an AI-powered analysis
        </p>
      </div>

      {/* Main Content */}
      <div className="flex-1 p-8">
        <div className="max-w-3xl mx-auto">
          <h1 className="text-3xl font-bold mb-8">Contract Analysis</h1>

          {/* Dropzone */}
          <div
            {...getRootProps()}
            className={`border-2 border-dashed rounded-lg p-8 mb-6 text-center cursor-pointer
              ${isDragActive ? 'border-blue-500 bg-blue-50' : 'border-gray-300'}`}
          >
            <input {...getInputProps()} />
            {isDragActive ? (
              <p>Drop the file here...</p>
            ) : (
              <div>
                <p>Drag and drop a file here, or click to select a file</p>
                <p className="text-sm text-gray-500 mt-2">
                  Supported formats: .txt, .doc, .docx, .pdf
                </p>
              </div>
            )}
          </div>

          {/* File Info */}
          {file && (
            <div className="mb-6">
              <h3 className="text-lg font-semibold mb-2">Selected File:</h3>
              <p className="text-gray-600">{file.name}</p>
              <button
                onClick={handleReview}
                disabled={loading}
                className="mt-4 bg-blue-500 text-white px-6 py-2 rounded hover:bg-blue-600 disabled:bg-gray-400"
              >
                {loading ? 'Analyzing...' : 'Request Review'}
              </button>
              {status && (
                <div className="mt-4">
                  <p className="text-sm text-blue-600">{status}</p>
                  {progress > 0 && (
                    <div className="w-full bg-gray-200 rounded-full h-2.5 mt-2">
                      <div
                        className="bg-blue-600 h-2.5 rounded-full transition-all duration-300"
                        style={{ width: `${progress}%` }}
                      ></div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Error Message */}
          {error && (
            <div className="text-red-500 mb-6">
              {error}
            </div>
          )}

          {/* Results */}
          {summary && (
            <div className="space-y-6">
              <div>
                <h3 className="text-xl font-semibold mb-2">Summary</h3>
                <p className="text-gray-700 whitespace-pre-wrap">{summary}</p>
              </div>

              {analysis && (
                <div>
                  <h3 className="text-xl font-semibold mb-2">Analysis</h3>
                  
                  <div className="space-y-4">
                    <div>
                      <h4 className="font-semibold text-lg">Key Insights</h4>
                      <ul className="list-disc pl-5">
                        {analysis.keyInsights.map((insight: string, i: number) => (
                          <li key={i}>{insight}</li>
                        ))}
                      </ul>
                    </div>

                    <div>
                      <h4 className="font-semibold text-lg">Potential Issues</h4>
                      <ul className="list-disc pl-5">
                        {analysis.potentialIssues.map((issue: string, i: number) => (
                          <li key={i}>{issue}</li>
                        ))}
                      </ul>
                    </div>

                    <div>
                      <h4 className="font-semibold text-lg">Recommendations</h4>
                      <ul className="list-disc pl-5">
                        {analysis.recommendations.map((rec: string, i: number) => (
                          <li key={i}>{rec}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
