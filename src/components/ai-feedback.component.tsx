import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ThumbsUp, ThumbsDown } from '@carbon/react/icons';
import { type FeedbackRating, submitFeedback } from '../api/chartsearchai';
import styles from './ai-feedback.scss';

interface AiFeedbackProps {
  auditLogId: number;
  onComplete?: () => void;
}

const AiFeedback: React.FC<AiFeedbackProps> = ({ auditLogId, onComplete }) => {
  const { t } = useTranslation();
  const [rating, setRating] = useState<FeedbackRating | null>(null);
  const [comment, setComment] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(false);

  const handleRate = useCallback(
    async (selectedRating: FeedbackRating) => {
      setRating(selectedRating);

      if (selectedRating === 'positive') {
        setSubmitError(false);
        try {
          await submitFeedback({ auditLogId, rating: selectedRating });
          setSubmitted(true);
          onComplete?.();
        } catch {
          setSubmitError(true);
          setRating(null);
        }
      }
    },
    [auditLogId, onComplete],
  );

  const handleCommentSubmit = useCallback(async () => {
    setIsSubmitting(true);
    setSubmitError(false);
    try {
      await submitFeedback({
        auditLogId,
        rating: 'negative',
        comment: comment.trim() || undefined,
      });
      setSubmitted(true);
      onComplete?.();
    } catch {
      setSubmitError(true);
    }
    setIsSubmitting(false);
  }, [auditLogId, comment, onComplete]);

  const handleCommentKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleCommentSubmit();
      }
    },
    [handleCommentSubmit],
  );

  if (submitted) {
    return (
      <div className={styles.feedbackContainer}>
        <span className={styles.thanksText}>{t('feedbackThanks', 'Thanks for your feedback')}</span>
      </div>
    );
  }

  return (
    <div className={styles.feedbackContainer}>
      {submitError && <div role="alert">{t('feedbackFailed', 'Feedback could not be saved. Please try again.')}</div>}
      {!rating && (
        <div className={styles.ratingRow}>
          <span className={styles.promptText}>{t('wasThisHelpful', 'Was this helpful?')}</span>
          <button
            className={styles.ratingButton}
            onClick={() => handleRate('positive')}
            aria-label={t('helpful', 'Helpful')}
            title={t('helpful', 'Helpful')}
            type="button"
            disabled={isSubmitting}
          >
            <ThumbsUp size={16} />
          </button>
          <button
            className={styles.ratingButton}
            onClick={() => handleRate('negative')}
            aria-label={t('notHelpful', 'Not helpful')}
            title={t('notHelpful', 'Not helpful')}
            type="button"
            disabled={isSubmitting}
          >
            <ThumbsDown size={16} />
          </button>
        </div>
      )}

      {rating === 'negative' && (
        <div className={styles.commentSection}>
          <textarea
            className={styles.commentInput}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={handleCommentKeyDown}
            placeholder={t('feedbackPlaceholder', 'What was wrong? (optional)')}
            aria-label={t('feedbackPlaceholder', 'What was wrong? (optional)')}
            rows={2}
            maxLength={500}
            disabled={isSubmitting}
            autoFocus
          />
          <div className={styles.commentActions}>
            <button
              className={styles.cancelButton}
              onClick={() => {
                setRating(null);
                setComment('');
                onComplete?.();
              }}
              type="button"
              disabled={isSubmitting}
            >
              {t('cancel', 'Cancel')}
            </button>
            <button className={styles.submitButton} onClick={handleCommentSubmit} type="button" disabled={isSubmitting}>
              {t('submitFeedback', 'Submit')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default AiFeedback;
