'use client';

import { useState, useEffect, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import dynamic from 'next/dynamic';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { FileText, Upload, X, Plus, AlertCircle, Lightbulb, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ArrowLeft } from 'lucide-react';

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
  const [showProgress, setShowProgress] = useState(true);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [contractToDelete, setContractToDelete] = useState<string | null>(null);

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
                    loading: false
                  } : {}),
                  ...(data.type === 'error' ? {
                    error: data.message,
                    status: '',
                    loading: false
                  } : {})
                })
              }
            }));

            if (data.type === 'complete') {
              setTimeout(() => {
                setShowProgress(false);
              }, 3000);
            }

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

    setShowProgress(true);

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

  const handleDeleteClick = (fileId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setContractToDelete(fileId);
    setDeleteModalOpen(true);
  };

  const confirmDelete = () => {
    if (contractToDelete) {
      handleDeleteFile(contractToDelete);
      setDeleteModalOpen(false);
      setContractToDelete(null);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <AnimatePresence mode="wait">
        {selectedFileId && files[selectedFileId] ? (
          // Contract Detail View
          <motion.div
            key="detail"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="container mx-auto px-4 py-8"
          >
            <div className="max-w-5xl mx-auto">
              {/* Back Button */}
              <Button
                variant="ghost"
                onClick={() => setSelectedFileId(null)}
                className="mb-8 -ml-2 text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft className="h-5 w-5 mr-2" />
                Back to Contracts
              </Button>

              <div className="space-y-8">
                {/* Contract Header */}
                <div className="flex items-center justify-between">
                  <div>
                    <h1 className="text-3xl font-bold text-foreground mb-2">{files[selectedFileId].file.name}</h1>
                    <p className="text-sm text-muted-foreground">
                      Uploaded on {new Date().toLocaleDateString()}
                    </p>
                  </div>
                  <Button
                    onClick={() => handleReview(selectedFileId)}
                    disabled={files[selectedFileId].loading}
                    className="w-auto"
                  >
                    {files[selectedFileId].loading 
                      ? 'Analyzing...' 
                      : files[selectedFileId].analysis 
                        ? 'Analyze again'
                        : 'Request Review'}
                  </Button>
                </div>

                {/* Progress and Status */}
                {files[selectedFileId].status && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="space-y-2"
                  >
                    <p className="text-sm text-primary">{files[selectedFileId].status}</p>
                    {files[selectedFileId].progress > 0 && showProgress && (
                      <Progress value={files[selectedFileId].progress} className="h-2" />
                    )}
                  </motion.div>
                )}

                {/* Error Message */}
                {files[selectedFileId].error && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="p-4 rounded-lg bg-destructive/10 text-destructive flex items-center space-x-2"
                  >
                    <AlertCircle className="h-5 w-5 flex-shrink-0" />
                    <p>{files[selectedFileId].error}</p>
                  </motion.div>
                )}

                {/* Analysis Results */}
                {files[selectedFileId].analysis && (
                  <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="space-y-6"
                  >
                    {/* Key Insights Card */}
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

                    {/* Potential Issues Card */}
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

                    {/* Recommendations Card */}
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
                  </motion.div>
                )}
              </div>
            </div>
          </motion.div>
        ) : (
          // Grid View of Contracts
          <motion.div
            key="grid"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="container mx-auto px-4 py-8"
          >
            <h1 className="text-4xl font-bold mb-2 text-center text-foreground">AI that simplifies your contract</h1>
            <p className="text-lg text-muted-foreground text-center mb-12">Upload your contract and get instant insights, analysis, and recommendations.</p>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
              {/* Upload Card */}
              <div
                {...getRootProps()}
                className={`aspect-square rounded-xl border-2 border-dashed p-6 cursor-pointer transition-all flex flex-col items-center justify-center
                  ${isDragActive 
                    ? 'border-primary bg-primary/5 scale-105' 
                    : 'border-muted hover:border-primary/50 hover:bg-muted/50'
                  }`}
              >
                <input {...getInputProps()} />
                <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-4">
                  <Plus className="h-8 w-8 text-primary" />
                </div>
                <p className="text-lg font-medium text-center">Upload Contract</p>
                <p className="text-sm text-muted-foreground text-center mt-2">
                  Drop files here or click to upload
                </p>
              </div>

              {/* Contract Cards */}
              {Object.entries(files).map(([fileId, fileData]) => (
                <motion.div
                  key={fileId}
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="aspect-square rounded-xl border bg-card p-6 relative cursor-pointer hover:shadow-md transition-all"
                  onClick={() => setSelectedFileId(fileId)}
                >
                  <Button
                    variant="ghost"
                    size="icon"
                    className="absolute top-2 right-2 h-8 w-8 opacity-0 group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive"
                    onClick={(e) => handleDeleteClick(fileId, e)}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                  <div className="h-full flex flex-col">
                    <div className="mb-4">
                      <FileText className="h-8 w-8 text-primary mb-2" />
                      <h3 className="font-medium truncate">{fileData.file.name}</h3>
                      <p className="text-sm text-muted-foreground">
                        Uploaded on {new Date().toLocaleDateString()}
                      </p>
                    </div>
                    <div className="mt-auto">
                      <div className={`text-sm font-medium ${
                        fileData.analysis ? 'text-primary' : 'text-muted-foreground'
                      }`}>
                        {fileData.loading ? 'Analyzing...' :
                         fileData.analysis ? 'Reviewed' : 'Pending Review'}
                      </div>
                      {fileData.loading && fileData.progress > 0 && (
                        <Progress value={fileData.progress} className="h-1 mt-2" />
                      )}
                    </div>
                  </div>
                </motion.div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Delete Confirmation Modal */}
      <Dialog open={deleteModalOpen} onOpenChange={setDeleteModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Contract</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this contract? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteModalOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
