import { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/db';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const session = await getServerSession(req, res, authOptions);
    if (!session?.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { id } = req.query;
    if (!id || typeof id !== 'string') {
      return res.status(400).json({ error: 'Invalid contract ID' });
    }

    // GET request - Fetch contract
    if (req.method === 'GET') {
      const contract = await prisma.contract.findUnique({
        where: {
          id,
          userId: session.user.id
        }
      });

      if (!contract) {
        return res.status(404).json({ error: 'Contract not found' });
      }

      return res.json(contract);
    }

    // DELETE request - Delete contract
    if (req.method === 'DELETE') {
      const contract = await prisma.contract.findUnique({
        where: {
          id,
          userId: session.user.id
        }
      });

      if (!contract) {
        return res.status(404).json({ error: 'Contract not found' });
      }

      await prisma.contract.delete({
        where: {
          id,
          userId: session.user.id
        }
      });

      return res.json({ message: 'Contract deleted successfully' });
    }

    // PUT request - Update contract
    if (req.method === 'PUT') {
      const contract = await prisma.contract.findUnique({
        where: {
          id,
          userId: session.user.id
        }
      });

      if (!contract) {
        return res.status(404).json({ error: 'Contract not found' });
      }

      const updatedContract = await prisma.contract.update({
        where: {
          id,
          userId: session.user.id
        },
        data: {
          ...req.body,
          userId: session.user.id // Ensure userId cannot be changed
        }
      });

      return res.json(updatedContract);
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Error handling contract request:', error);
    return res.status(500).json({ 
      error: error instanceof Error ? error.message : 'An error occurred' 
    });
  }
} 