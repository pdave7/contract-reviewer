'use client';

import { useState, useEffect } from 'react';
import { useDropzone } from 'react-dropzone';
import dynamic from 'next/dynamic';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { FileText, Upload, X, Plus, AlertCircle, Lightbulb, AlertTriangle, CheckCircle2 } from 'lucide-react';

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
    <TooltipProvider>
      <div className="flex min-h-screen bg-background">
        {/* Sidebar */}
        <motion.div 
          initial={{ x: -300 }}
          animate={{ x: 0 }}
          className="w-80 bg-muted/40 p-6 flex flex-col border-r"
        >
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-2xl font-bold text-foreground">Contract Reviewer</h2>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  onClick={handleAddFile}
                  variant="outline"
                  size="icon"
                  className="rounded-full"
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Add new contract</TooltipContent>
            </Tooltip>
          </div>
          <div className="flex-1 overflow-y-auto space-y-2">
            <AnimatePresence>
              {Object.entries(files).map(([fileId, fileData]) => (
                <motion.div
                  key={fileId}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, x: -100 }}
                  className={`p-4 rounded-lg cursor-pointer flex items-center space-x-3 transition-colors ${
                    selectedFileId === fileId 
                      ? 'bg-primary/10 text-primary'
                      : 'hover:bg-muted'
                  }`}
                  onClick={() => setSelectedFileId(fileId)}
                >
                  <FileText className="h-5 w-5 flex-shrink-0" />
                  <span className="truncate flex-1 text-sm">{fileData.file.name}</span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteFile(fileId);
                        }}
                        variant="ghost"
                        size="icon"
                        className="opacity-0 group-hover:opacity-100 h-8 w-8"
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Delete file</TooltipContent>
                  </Tooltip>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </motion.div>

        {/* Main Content */}
        <div className="flex-1 p-8">
          <AnimatePresence mode="wait">
            {selectedFileId && files[selectedFileId] ? (
              <motion.div
                key="analysis"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="max-w-4xl mx-auto"
              >
                <h1 className="text-4xl font-bold mb-2 text-center text-foreground">AI that simplifies your contract</h1>
                <p className="text-lg text-muted-foreground text-center mb-12">Upload your contract and get instant insights, analysis, and recommendations.</p>

                {/* File Info */}
                <div className="mb-8 space-y-4">
                  <div className="flex items-center space-x-2 text-muted-foreground">
                    <FileText className="h-5 w-5" />
                    <span>{files[selectedFileId].file.name}</span>
                  </div>
                  <Button
                    onClick={() => handleReview(selectedFileId)}
                    disabled={files[selectedFileId].loading}
                    className="w-full sm:w-auto"
                  >
                    {files[selectedFileId].loading ? 'Analyzing...' : 'Request Review'}
                  </Button>
                  {files[selectedFileId].status && (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="space-y-2"
                    >
                      <p className="text-sm text-primary">{files[selectedFileId].status}</p>
                      {files[selectedFileId].progress > 0 && (
                        <Progress value={files[selectedFileId].progress} className="h-2" />
                      )}
                    </motion.div>
                  )}
                </div>

                {/* Error Message */}
                {files[selectedFileId].error && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="mb-8 p-4 rounded-lg bg-destructive/10 text-destructive flex items-center space-x-2"
                  >
                    <AlertCircle className="h-5 w-5 flex-shrink-0" />
                    <p>{files[selectedFileId].error}</p>
                  </motion.div>
                )}

                {/* Results */}
                {files[selectedFileId].summary && (
                  <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="space-y-12"
                  >
                    <div className="bg-card rounded-xl p-8 shadow-sm border">
                      <h3 className="text-2xl font-semibold mb-6">Summary</h3>
                      <p className="text-card-foreground whitespace-pre-wrap leading-relaxed">{files[selectedFileId].summary}</p>
                    </div>

                    {files[selectedFileId].analysis && (
                      <div className="space-y-8">
                        <h3 className="text-2xl font-semibold">Analysis</h3>
                        
                        <div className="grid gap-8 md:grid-cols-2 lg:grid-cols-3">
                          <motion.div
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            className="bg-card rounded-xl p-8 shadow-sm border relative overflow-hidden"
                          >
                            <div className="absolute top-0 left-0 w-full h-1 bg-primary/20" />
                            <div className="flex items-center space-x-3 mb-6">
                              <Lightbulb className="h-6 w-6 text-primary" />
                              <h4 className="font-semibold text-xl">Key Insights</h4>
                            </div>
                            <ul className="space-y-4">
                              {files[selectedFileId].analysis.keyInsights.map((insight: string, i: number) => (
                                <li key={i} className="flex items-start space-x-3 p-2 rounded hover:bg-muted/50 transition-colors">
                                  <span className="text-primary mt-1">•</span>
                                  <span className="text-card-foreground leading-relaxed">{insight}</span>
                                </li>
                              ))}
                            </ul>
                          </motion.div>

                          <motion.div
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: 0.1 }}
                            className="bg-card rounded-xl p-8 shadow-sm border relative overflow-hidden"
                          >
                            <div className="absolute top-0 left-0 w-full h-1 bg-destructive/20" />
                            <div className="flex items-center space-x-3 mb-6">
                              <AlertTriangle className="h-6 w-6 text-destructive" />
                              <h4 className="font-semibold text-xl">Potential Issues</h4>
                            </div>
                            <ul className="space-y-4">
                              {files[selectedFileId].analysis.potentialIssues.map((issue: string, i: number) => (
                                <li key={i} className="flex items-start space-x-3 p-2 rounded hover:bg-muted/50 transition-colors">
                                  <span className="text-destructive mt-1">•</span>
                                  <span className="text-card-foreground leading-relaxed">{issue}</span>
                                </li>
                              ))}
                            </ul>
                          </motion.div>

                          <motion.div
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: 0.2 }}
                            className="bg-card rounded-xl p-8 shadow-sm border relative overflow-hidden"
                          >
                            <div className="absolute top-0 left-0 w-full h-1 bg-primary/20" />
                            <div className="flex items-center space-x-3 mb-6">
                              <CheckCircle2 className="h-6 w-6 text-primary" />
                              <h4 className="font-semibold text-xl">Recommendations</h4>
                            </div>
                            <ul className="space-y-4">
                              {files[selectedFileId].analysis.recommendations.map((rec: string, i: number) => (
                                <li key={i} className="flex items-start space-x-3 p-2 rounded hover:bg-muted/50 transition-colors">
                                  <span className="text-primary mt-1">•</span>
                                  <span className="text-card-foreground leading-relaxed">{rec}</span>
                                </li>
                              ))}
                            </ul>
                          </motion.div>
                        </div>
                      </div>
                    )}
                  </motion.div>
                )}
              </motion.div>
            ) : (
              <motion.div
                key="dropzone"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="h-full flex flex-col items-center justify-center"
              >
                <motion.h1 
                  initial={{ opacity: 0, y: -20 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="text-5xl font-bold mb-4 text-center text-foreground"
                >
                  AI that simplifies your contract
                </motion.h1>
                <motion.p 
                  initial={{ opacity: 0, y: -20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.1 }}
                  className="text-xl text-muted-foreground text-center mb-12"
                >
                  Upload your contract and get instant insights, analysis, and recommendations.
                </motion.p>
                <div
                  {...getRootProps()}
                  className={`border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-all max-w-2xl w-full mx-auto
                    ${isDragActive 
                      ? 'border-primary bg-primary/5 scale-105' 
                      : 'border-muted hover:border-primary/50 hover:bg-muted/50'
                    }`}
                >
                  <input {...getInputProps()} />
                  <motion.div
                    initial={{ scale: 1 }}
                    animate={{ scale: isDragActive ? 1.1 : 1 }}
                    className="space-y-6"
                  >
                    <div className="w-24 h-24 mx-auto rounded-full bg-primary/10 flex items-center justify-center">
                      <Upload className="h-12 w-12 text-primary" />
                    </div>
                    {isDragActive ? (
                      <p className="text-xl text-primary font-medium">Drop the file here...</p>
                    ) : (
                      <>
                        <p className="text-xl text-foreground font-medium">
                          Drag and drop your contract here
                        </p>
                        <p className="text-sm text-muted-foreground">
                          Supported formats: .txt, .doc, .docx, .pdf
                        </p>
                      </>
                    )}
                  </motion.div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </TooltipProvider>
  );
}
