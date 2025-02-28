import { NextApiRequest, NextApiResponse } from 'next';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    return res.json({ message: 'Test endpoint is working' });
  }
  
  if (req.method === 'POST') {
    return res.json({ message: 'POST request received' });
  }
  
  return res.status(405).json({ error: 'Method not allowed' });
} 