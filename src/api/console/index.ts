import { Router } from 'express';
import express from 'express';
import { requireConsoleSession, requirePeopleAdminMiddleware, requireCsrf } from '../../web/authMiddleware';
import dashboard from './dashboard';
import directory from './directory';
import cycles from './cycles';
import reviews from './reviews';
import upwardFeedback from './upwardFeedback';
import reminders from './reminders';
import audit from './audit';
import operations from './operations';
import exportsRouter from './exports';

const router = Router();

router.use(express.json({ limit: '256kb' }));
router.use(requireConsoleSession);
router.use(requireCsrf);
router.use(requirePeopleAdminMiddleware);

router.use(dashboard);
router.use(directory);
router.use(cycles);
router.use(reviews);
router.use(upwardFeedback);
router.use(reminders);
router.use(audit);
router.use(operations);
router.use(exportsRouter);

export default router;
