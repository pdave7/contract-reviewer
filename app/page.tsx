'use client';

import { useState, useEffect } from 'react';
import { useDropzone } from 'react-dropzone';
import dynamic from 'next/dynamic';

interface Analysis {
  keyInsights: string[];
  potentialIssues: string[];
  recommendations: string[];
}

interface FileData {
  id: string;
  file: File;
  summary: string;
  analysis: Analysis | null;
  error: string;
  status: string;
  progress: number;
  loading: boolean;
}

// Dynamically import PDF.js only on the client side
let pdfjsLib: typeof import('pdfjs-dist') | null = null;

export default function Home() {
  const [files, setFiles] = useState<{ [key: string]: FileData }>({});
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const maxRetries = 3;

  // Initialize PDF.js on the client side
  useEffect(() => {
    const loadPdfjs = async () => {
      if (typeof window !== 'undefined') {
        try {
          const pdfjs = await import('pdfjs-dist');
          pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
          pdfjsLib = pdfjs;
        } catch (error) {
          console.error('Error loading PDF.js:', error);
        }
      }
    };
    loadPdfjs();
  }, []);

  const resetFileState = (fileId: string) => {
    setFiles(prev => ({
      ...prev,
      [fileId]: {
        ...prev[fileId],
        summary: '',
        analysis: null,
        error: '',
        status: '',
        progress: 0,
      }
    }));
  };

  const processStream = async (response: Response, fileId: string) => {
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No reader available');
    }

    let lastPingTime = Date.now();
    const checkConnection = setInterval(() => {
      if (Date.now() - lastPingTime > 15000) {
        clearInterval(checkConnection);
        throw new Error('Connection lost - no ping received');
      }
    }, 1000);

    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += new TextDecoder().decode(value);
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          
          try {
            const data = JSON.parse(line);
            setFiles(prev => ({
              ...prev,
              [fileId]: {
                ...prev[fileId],
                ...(data.type === 'ping' ? {} : {
                  status: data.message || prev[fileId].status,
                  progress: data.progress || prev[fileId].progress,
                  ...(data.type === 'complete' ? {
                    summary: data.summary,
                    analysis: data.analysis,
                    status: 'Analysis complete!',
                    progress: 100,
                  } : {}),
                  ...(data.type === 'error' ? {
                    error: data.message,
                    status: '',
                  } : {})
                })
              }
            }));

            if (data.type === 'ping') {
              lastPingTime = Date.now();
            }
          } catch (e) {
            console.error('Error processing line:', line, e);
            if (e instanceof Error && e.message !== 'Connection lost - no ping received') {
              throw e;
            }
          }
        }
      }
    } finally {
      clearInterval(checkConnection);
      reader.releaseLock();
    }
  };

  const attemptAnalysis = async (text: string, fileId: string, attempt: number = 1): Promise<void> => {
    const maxAttempts = 3;
    const backoffDelay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);

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

      await processStream(response, fileId);
      setRetryCount(0);
    } catch (error) {
      console.error(`Attempt ${attempt} failed:`, error);
      
      if (attempt < maxAttempts) {
        setFiles(prev => ({
          ...prev,
          [fileId]: {
            ...prev[fileId],
            status: `Connection issue. Retrying in ${backoffDelay/1000} seconds... (${attempt}/${maxAttempts})`
          }
        }));
        await new Promise(resolve => setTimeout(resolve, backoffDelay));
        return attemptAnalysis(text, fileId, attempt + 1);
      }
      
      throw error;
    }
  };

  const extractTextFromPDF = async (pdfData: ArrayBuffer): Promise<string> => {
    if (!pdfjsLib) {
      throw new Error('PDF.js is not initialized');
    }

    try {
      const pdf = await pdfjsLib.getDocument({ data: pdfData }).promise;
      let text = '';
      
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const pageText = content.items
          .map((item: any) => item.str)
          .join(' ');
        text += pageText + '\n\n';
      }
      
      return text;
    } catch (error) {
      console.error('Error extracting text from PDF:', error);
      throw new Error('Failed to extract text from PDF. Please ensure the file is not corrupted or password protected.');
    }
  };

  const handleReview = async (fileId: string) => {
    const fileData = files[fileId];
    if (!fileData) return;

    setFiles(prev => ({
      ...prev,
      [fileId]: {
        ...prev[fileId],
        loading: true,
        error: '',
        status: 'Reading file...',
        progress: 0,
      }
    }));

    try {
      const reader = new FileReader();
      reader.onload = async (e) => {
        let text: string;
        const fileContent = e.target?.result;
        
        if (fileData.file.type === 'application/pdf') {
          if (!(fileContent instanceof ArrayBuffer)) {
            throw new Error('Failed to read PDF file');
          }
          
          text = await extractTextFromPDF(fileContent);
          
          if (!text.trim()) {
            throw new Error('No text could be extracted from the PDF');
          }
        } else {
          if (typeof fileContent !== 'string') {
            throw new Error('Failed to read text file');
          }
          text = fileContent;
        }

        setFiles(prev => ({
          ...prev,
          [fileId]: {
            ...prev[fileId],
            status: 'Initializing analysis...',
          }
        }));
        
        try {
          await attemptAnalysis(JSON.stringify({
            type: fileData.file.type === 'application/pdf' ? 'pdf' : 'text',
            content: text,
            name: fileData.file.name
          }), fileId);
        } catch (error) {
          setFiles(prev => ({
            ...prev,
            [fileId]: {
              ...prev[fileId],
              error: 'Failed to analyze document: ' + (error instanceof Error ? error.message : 'Unknown error'),
              status: '',
              loading: false,
            }
          }));
        }
      };

      reader.onerror = () => {
        setFiles(prev => ({
          ...prev,
          [fileId]: {
            ...prev[fileId],
            error: 'Failed to read the file. Please try again.',
            status: '',
            loading: false,
          }
        }));
      };

      if (fileData.file.type === 'application/pdf') {
        reader.readAsArrayBuffer(fileData.file);
      } else {
        reader.readAsText(fileData.file);
      }
    } catch (error) {
      setFiles(prev => ({
        ...prev,
        [fileId]: {
          ...prev[fileId],
          error: 'Error processing file: ' + (error instanceof Error ? error.message : 'Unknown error'),
          status: '',
          loading: false,
        }
      }));
    }
  };

  const handleAddFile = () => {
    setSelectedFileId(null);
  };

  const handleDeleteFile = (fileId: string) => {
    setFiles(prev => {
      const newFiles = { ...prev };
      delete newFiles[fileId];
      return newFiles;
    });
    if (selectedFileId === fileId) {
      setSelectedFileId(Object.keys(files)[0] || null);
    }
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: (acceptedFiles) => {
      const file = acceptedFiles[0];
      if (file.size > 100 * 1024 * 1024) {
        return;
      }
      const newFileId = `file-${Date.now()}`;
      setFiles(prev => ({
        ...prev,
        [newFileId]: {
          id: newFileId,
          file,
          summary: '',
          analysis: null,
          error: '',
          status: '',
          progress: 0,
          loading: false,
        }
      }));
      setSelectedFileId(newFileId);
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

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <div className="w-64 bg-gray-100 p-6 flex flex-col">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-xl font-bold">Contract Reviewer</h2>
          <button
            onClick={handleAddFile}
            className="bg-blue-500 text-white p-2 rounded hover:bg-blue-600"
          >
            + Add
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {Object.entries(files).map(([fileId, fileData]) => (
            <div
              key={fileId}
              className={`p-3 mb-2 rounded cursor-pointer flex justify-between items-center ${
                selectedFileId === fileId ? 'bg-blue-100' : 'hover:bg-gray-200'
              }`}
              onClick={() => setSelectedFileId(fileId)}
            >
              <span className="truncate flex-1">{fileData.file.name}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleDeleteFile(fileId);
                }}
                className="ml-2 text-red-500 hover:text-red-700"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 p-8">
        {selectedFileId && files[selectedFileId] ? (
          <div className="max-w-3xl mx-auto">
            <h1 className="text-3xl font-bold mb-8">Contract Analysis</h1>

            {/* File Info */}
            <div className="mb-6">
              <h3 className="text-lg font-semibold mb-2">Selected File:</h3>
              <p className="text-gray-600">{files[selectedFileId].file.name}</p>
              <button
                onClick={() => handleReview(selectedFileId)}
                disabled={files[selectedFileId].loading}
                className="mt-4 bg-blue-500 text-white px-6 py-2 rounded hover:bg-blue-600 disabled:bg-gray-400"
              >
                {files[selectedFileId].loading ? 'Analyzing...' : 'Request Review'}
              </button>
              {files[selectedFileId].status && (
                <div className="mt-4">
                  <p className="text-sm text-blue-600">{files[selectedFileId].status}</p>
                  {files[selectedFileId].progress > 0 && (
                    <div className="w-full bg-gray-200 rounded-full h-2.5 mt-2">
                      <div
                        className="bg-blue-600 h-2.5 rounded-full transition-all duration-300"
                        style={{ width: `${files[selectedFileId].progress}%` }}
                      ></div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Error Message */}
            {files[selectedFileId].error && (
              <div className="text-red-500 mb-6">
                {files[selectedFileId].error}
              </div>
            )}

            {/* Results */}
            {files[selectedFileId].summary && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-xl font-semibold mb-2">Summary</h3>
                  <p className="text-gray-700 whitespace-pre-wrap">{files[selectedFileId].summary}</p>
                </div>

                {files[selectedFileId].analysis && (
                  <div>
                    <h3 className="text-xl font-semibold mb-2">Analysis</h3>
                    
                    <div className="space-y-4">
                      <div>
                        <h4 className="font-semibold text-lg">Key Insights</h4>
                        <ul className="list-disc pl-5">
                          {files[selectedFileId].analysis.keyInsights.map((insight: string, i: number) => (
                            <li key={i}>{insight}</li>
                          ))}
                        </ul>
                      </div>

                      <div>
                        <h4 className="font-semibold text-lg">Potential Issues</h4>
                        <ul className="list-disc pl-5">
                          {files[selectedFileId].analysis.potentialIssues.map((issue: string, i: number) => (
                            <li key={i}>{issue}</li>
                          ))}
                        </ul>
                      </div>

                      <div>
                        <h4 className="font-semibold text-lg">Recommendations</h4>
                        <ul className="list-disc pl-5">
                          {files[selectedFileId].analysis.recommendations.map((rec: string, i: number) => (
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
        ) : (
          <div
            {...getRootProps()}
            className={`border-2 border-dashed rounded-lg p-8 mb-6 text-center cursor-pointer max-w-3xl mx-auto
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
        )}
      </div>
    </div>
  );
}
