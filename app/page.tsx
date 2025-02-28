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
import { useSession } from 'next-auth/react';
import axios from 'axios';

interface Analysis {
  keyInsights: {
    summary: string;
    points: string[];
  };
  potentialIssues: {
    summary: string;
    points: string[];
  };
  recommendations: {
    summary: string;
    points: string[];
  };
  financialTerms: {
    propertyValue: string;
    paymentSchedule: string;
    additionalCosts: string[];
    financialConditions: string[];
  };
}

interface Contract {
  id: string;
  name: string;
  summary: string;
  analysis: Analysis | null;
  status: string;
  createdAt: string;
  fileType: string;
}

interface FileData {
  name: string;
  file?: File;
  analysis?: Analysis | null;
  status?: string;
  progress?: number;
  loading?: boolean;
  createdAt?: string;
  error?: string;
}

// Dynamically import PDF.js only on the client side
let pdfjsLib: typeof import('pdfjs-dist') | null = null;

export default function Home() {
  const { data: session, status } = useSession();
  const [files, setFiles] = useState<{ [key: string]: FileData }>({});
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const maxRetries = 3;
  const [showProgress, setShowProgress] = useState(true);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [contractToDelete, setContractToDelete] = useState<string | null>(null);
  const [isLoadingContracts, setIsLoadingContracts] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string>('Uploading file...');
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [fileData, setFileData] = useState<FileData | null>(null);

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

  useEffect(() => {
    if (status === 'authenticated') {
      fetchContracts();
    } else if (status === 'unauthenticated') {
      setIsLoading(false);
    }
  }, [status]);

  const fetchContracts = async () => {
    try {
      setIsLoadingContracts(true);
      const response = await fetch('/api/contracts');
      if (!response.ok) throw new Error('Failed to fetch contracts');
      const data = await response.json();
      setContracts(data);
    } catch (error) {
      console.error('Error fetching contracts:', error);
    } finally {
      setIsLoadingContracts(false);
    }
  };

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

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (file.size > 100 * 1024 * 1024) {
      setError('File size must be less than 100MB');
      return;
    }

    setFileData({
      name: file.name,
      file
    });
    setError(null);
    setProgress('');
    setAnalysis(null);

    // Automatically start analysis
    handleAnalysis(file);
  };

  const handleAnalysis = async (file: File) => {
    try {
      setIsLoading(true);
      setError(null);
      setProgress('Preparing file for upload...');

      const formData = new FormData();
      formData.append('file', file);

      setProgress('Uploading file...');
      const response = await axios.post('/api/upload', formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
        onUploadProgress: (progressEvent) => {
          if (progressEvent.total) {
            const percentCompleted = Math.round((progressEvent.loaded * 100) / progressEvent.total);
            setProgress(`Uploading file: ${percentCompleted}%`);
          }
        },
        timeout: 300000, // 5 minutes
      });

      if (response.data.error) {
        throw new Error(response.data.error);
      }

      if (response.data.analysis) {
        setAnalysis(response.data.analysis);
        setProgress('Analysis complete!');
        
        // Refresh the contracts list
        await fetchContracts();
      } else {
        throw new Error('No analysis received from server');
      }
    } catch (err) {
      console.error('Error during analysis:', err);
      setError(err instanceof Error ? err.message : 'An error occurred during analysis');
      setProgress('');
    } finally {
      setIsLoading(false);
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
    const file = fileData?.file;
    if (!file) return;

    setShowProgress(true);
    await handleAnalysis(file);
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
        setError('File size must be less than 100MB');
        return;
      }

      // Set the file data directly instead of using the files state
      setFileData({
        name: file.name,
        file
      });
      setError(null);
      setProgress('');
      setAnalysis(null);

      // Automatically start analysis
      handleAnalysis(file);
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
        {fileData ? (
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
                onClick={() => {
                  setFileData(null);
                  setAnalysis(null);
                  setProgress('');
                  setError(null);
                }}
                className="mb-8 -ml-2 text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft className="h-5 w-5 mr-2" />
                Back to Contracts
              </Button>

              <div className="space-y-8">
                {/* Contract Header */}
                <div className="flex items-center justify-between">
                  <div>
                    <h1 className="text-3xl font-bold text-foreground mb-2">
                      {fileData.name}
                    </h1>
                    <p className="text-sm text-muted-foreground">
                      Uploaded on {new Date().toLocaleDateString()}
                    </p>
                  </div>
                </div>

                {/* Progress and Status */}
                {progress && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="space-y-2"
                  >
                    <p className="text-sm text-primary">{progress}</p>
                    {isLoading && (
                      <Progress value={progress.includes('%') ? parseInt(progress) : 0} className="h-2" />
                    )}
                  </motion.div>
                )}

                {/* Error Message */}
                {error && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="p-4 rounded-lg bg-destructive/10 text-destructive flex items-center space-x-2"
                  >
                    <AlertCircle className="h-5 w-5 flex-shrink-0" />
                    <p>{error}</p>
                  </motion.div>
                )}

                {/* Analysis Results */}
                {analysis && (
                  <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="space-y-6"
                  >
                    {/* Property Cost Display */}
                    {analysis.financialTerms.propertyValue && analysis.financialTerms.propertyValue !== 'Not specified' ? (
                      <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="bg-primary/5 rounded-xl p-8 shadow-sm border-2 border-primary/20 text-center"
                      >
                        <h2 className="text-3xl font-bold text-primary mb-2">Property Value</h2>
                        <p className="text-4xl font-bold">{analysis.financialTerms.propertyValue}</p>
                        {analysis.financialTerms.paymentSchedule && analysis.financialTerms.paymentSchedule !== 'Not specified' && (
                          <p className="text-muted-foreground mt-2">{analysis.financialTerms.paymentSchedule}</p>
                        )}
                      </motion.div>
                    ) : null}

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
                      {analysis.keyInsights.summary && (
                        <p className="text-lg mb-4 text-muted-foreground">{analysis.keyInsights.summary}</p>
                      )}
                      <ul className="list-disc pl-5 space-y-2">
                        {analysis.keyInsights.points.map((insight, i) => (
                          <li key={i} className="text-lg">{insight}</li>
                        ))}
                      </ul>
                    </motion.div>

                    {/* Recommendations Card */}
                    <motion.div
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.1 }}
                      className="bg-card rounded-xl p-8 shadow-sm border relative overflow-hidden"
                    >
                      <div className="absolute top-0 left-0 w-full h-1 bg-green-500/20" />
                      <div className="flex items-center space-x-3 mb-6">
                        <CheckCircle2 className="h-6 w-6 text-green-500" />
                        <h4 className="font-semibold text-xl">Recommendations</h4>
                      </div>
                      {analysis.recommendations.summary && (
                        <p className="text-lg mb-4 text-muted-foreground">{analysis.recommendations.summary}</p>
                      )}
                      <ul className="list-disc pl-5 space-y-2">
                        {analysis.recommendations.points.map((rec, i) => (
                          <li key={i} className="text-lg">{rec}</li>
                        ))}
                      </ul>
                    </motion.div>

                    {/* Potential Issues Card */}
                    <motion.div
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.2 }}
                      className="bg-card rounded-xl p-8 shadow-sm border relative overflow-hidden"
                    >
                      <div className="absolute top-0 left-0 w-full h-1 bg-destructive/20" />
                      <div className="flex items-center space-x-3 mb-6">
                        <AlertTriangle className="h-6 w-6 text-destructive" />
                        <h4 className="font-semibold text-xl">Potential Issues</h4>
                      </div>
                      {analysis.potentialIssues.summary && (
                        <p className="text-lg mb-4 text-muted-foreground">{analysis.potentialIssues.summary}</p>
                      )}
                      <ul className="list-disc pl-5 space-y-2">
                        {analysis.potentialIssues.points.map((issue, i) => (
                          <li key={i} className="text-lg">{issue}</li>
                        ))}
                      </ul>
                    </motion.div>

                    {/* Next Steps Card */}
                    <motion.div
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.3 }}
                      className="bg-card rounded-xl p-8 shadow-sm border relative overflow-hidden"
                    >
                      <div className="absolute top-0 left-0 w-full h-1 bg-blue-500/20" />
                      <div className="flex items-center space-x-3 mb-6">
                        <ArrowLeft className="h-6 w-6 text-blue-500" />
                        <h4 className="font-semibold text-xl">Next Steps</h4>
                      </div>
                      <div className="space-y-4">
                        {analysis.financialTerms.additionalCosts.length > 0 && (
                          <div>
                            <h5 className="font-medium text-lg mb-2">Additional Costs to Consider</h5>
                            <ul className="list-disc pl-5 space-y-2">
                              {analysis.financialTerms.additionalCosts.map((cost, i) => (
                                <li key={i} className="text-lg">{cost}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {analysis.financialTerms.financialConditions.length > 0 && (
                          <div>
                            <h5 className="font-medium text-lg mb-2">Financial Conditions</h5>
                            <ul className="list-disc pl-5 space-y-2">
                              {analysis.financialTerms.financialConditions.map((condition, i) => (
                                <li key={i} className="text-lg">{condition}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
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
              {[...Object.entries(files), ...contracts.map(c => [c.id, c] as [string, Contract])].map(([id, data]) => (
                <motion.div
                  key={id}
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="aspect-square rounded-xl border bg-card p-6 relative cursor-pointer hover:shadow-md transition-all"
                  onClick={() => {
                    if ('file' in data) {
                      setFileData({
                        name: data.name,
                        file: data.file
                      });
                    } else {
                      // For existing contracts from the database
                      setFileData({
                        name: data.name,
                        analysis: data.analysis
                      });
                    }
                  }}
                >
                  <Button
                    variant="ghost"
                    size="icon"
                    className="absolute top-2 right-2 h-8 w-8 opacity-0 group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive"
                    onClick={(e) => handleDeleteClick(id, e)}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                  <div className="h-full flex flex-col">
                    <div className="mb-4">
                      <FileText className="h-8 w-8 text-primary mb-2" />
                      <h3 className="font-medium truncate">
                        {'file' in data ? data.name : data.name}
                      </h3>
                      <p className="text-sm text-muted-foreground">
                        {'file' in data ? 
                          `Uploaded on ${new Date().toLocaleDateString()}` :
                          `Uploaded on ${new Date(data.createdAt || Date.now()).toLocaleDateString()}`
                        }
                      </p>
                    </div>
                    <div className="mt-auto">
                      <div className={`text-sm font-medium ${
                        ('file' in data ? data.analysis : data.analysis) ? 'text-primary' : 'text-muted-foreground'
                      }`}>
                        {'file' in data ? 
                          (data.loading ? 'Analyzing...' :
                           data.analysis ? 'Reviewed' : 'Pending Review') :
                          'Reviewed'
                        }
                      </div>
                      {'file' in data && data.loading && data.progress && data.progress > 0 && (
                        <Progress value={data.progress} className="h-1 mt-2" />
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

      {analysis && (
        <div className="mt-8 space-y-8">
          <h2 className="text-2xl font-bold mb-4">Contract Analysis</h2>
          
          {/* Key Terms */}
          <div className="bg-card rounded-xl p-8 shadow-sm border">
            <h3 className="text-xl font-semibold mb-4 flex items-center">
              <FileText className="h-6 w-6 text-primary mr-2" />
              Key Terms
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <h4 className="font-medium mb-2">Parties Involved</h4>
                <ul className="list-disc pl-5 space-y-1">
                  {analysis.keyInsights.points.map((party, i) => (
                    <li key={i}>{party}</li>
                  ))}
                </ul>
              </div>
              <div className="space-y-4">
                {analysis.financialTerms.propertyValue && (
                  <div>
                    <h4 className="font-medium mb-1">Property Value</h4>
                    <p>{analysis.financialTerms.propertyValue}</p>
                  </div>
                )}
                {analysis.financialTerms.paymentSchedule && (
                  <div>
                    <h4 className="font-medium mb-1">Payment Schedule</h4>
                    <p>{analysis.financialTerms.paymentSchedule}</p>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Financial Terms */}
          <div className="bg-card rounded-xl p-8 shadow-sm border">
            <h3 className="text-xl font-semibold mb-4 flex items-center">
              <svg
                className="h-6 w-6 text-green-600 mr-2"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              Financial Terms
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-4">
                {analysis.financialTerms.additionalCosts.length > 0 && (
                  <div>
                    <h4 className="font-medium mb-1">Additional Costs</h4>
                    <ul className="list-disc pl-5 space-y-1">
                      {analysis.financialTerms.additionalCosts.map((cost, i) => (
                        <li key={i}>{cost}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {analysis.financialTerms.financialConditions.length > 0 && (
                  <div>
                    <h4 className="font-medium mb-1">Financial Conditions</h4>
                    <ul className="list-disc pl-5 space-y-1">
                      {analysis.financialTerms.financialConditions.map((condition, i) => (
                        <li key={i}>{condition}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
