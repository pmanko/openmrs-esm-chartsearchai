import { Type, validators } from '@openmrs/esm-framework';

export const configSchema = {
  aiSearchPlaceholder: {
    _type: Type.String,
    _default: 'Ask AI about this patient...',
    _description: 'Placeholder text for the AI search input',
  },
  maxQuestionLength: {
    _type: Type.Number,
    _default: 1000,
    _description: 'Maximum number of characters allowed in a question',
  },
  chatLaunchMode: {
    _type: Type.String,
    _default: 'both',
    _description: 'Controls how the AI chat panel is launched. One of: "floating", "workspace", "both"',
    _validators: [validators.oneOf(['floating', 'workspace', 'both'])],
  },
  showModelPicker: {
    _type: Type.Boolean,
    _default: true,
    _description: 'Show the med-agent-hub product-profile picker in the chat panel footer.',
  },
};

export interface ChartSearchAiConfig {
  aiSearchPlaceholder: string;
  maxQuestionLength: number;
  chatLaunchMode: 'floating' | 'workspace' | 'both';
  showModelPicker: boolean;
}
