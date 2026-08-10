import type { Request, Response } from 'express'
import { pool } from './db.js'

export async function approveExpense(req: Request, res: Response): Promise<void> {
  const expenseId = req.params.id
  const approverId = req.body.approverId

  if (!expenseId || !approverId) {
    res.status(400).json({ error: 'missing fields' })
    return
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const expense = await client.query(
      'SELECT id, status, amount_cents FROM expenses WHERE id = $1',
      [expenseId],
    )

    if (expense.rowCount === 0) {
      await client.query('ROLLBACK')
      res.status(404).json({ error: 'expense not found' })
      return
    }

    await client.query(
      'UPDATE expenses SET status = $1, approved_by = $2, approved_at = NOW() WHERE id = $3',
      ['approved', approverId, expenseId],
    )

    await client.query(
      'INSERT INTO audit_log(entity_id, action, actor_id) VALUES ($1, $2, $3)',
      [expenseId, 'expense_approved', approverId],
    )

    await client.query('COMMIT')
    res.status(200).json({ ok: true })
  } catch (error) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: 'internal error' })
  } finally {
    client.release()
  }
}
