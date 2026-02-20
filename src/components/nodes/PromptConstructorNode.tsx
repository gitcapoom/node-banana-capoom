"use client";

import { useCallback, useState, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useCommentNavigation } from "@/hooks/useCommentNavigation";
import { usePromptAutocomplete } from "@/hooks/usePromptAutocomplete";
import { useWorkflowStore } from "@/store/workflowStore";
import { PromptConstructorNodeData, PromptNodeData, LLMGenerateNodeData, AvailableVariable } from "@/types";
import { PromptConstructorEditorModal } from "@/components/modals/PromptConstructorEditorModal";
import { parseVarTags } from "@/utils/parseVarTags";

type PromptConstructorNodeType = Node<PromptConstructorNodeData, "promptConstructor">;

export function PromptConstructorNode({ id, data, selected }: NodeProps<PromptConstructorNodeType>) {
  const nodeData = data;
  const commentNavigation = useCommentNavigation(id);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const edges = useWorkflowStore((state) => state.edges);
  const nodes = useWorkflowStore((state) => state.nodes);
  const incrementModalCount = useWorkflowStore((state) => state.incrementModalCount);
  const decrementModalCount = useWorkflowStore((state) => state.decrementModalCount);

  // Local state for template to prevent cursor jumping
  const [localTemplate, setLocalTemplate] = useState(nodeData.template);
  const [isEditing, setIsEditing] = useState(false);
  const [isModalOpenLocal, setIsModalOpenLocal] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Sync from props when not actively editing
  useEffect(() => {
    if (!isEditing) {
      setLocalTemplate(nodeData.template);
    }
  }, [nodeData.template, isEditing]);

  // Get available variables from connected prompt nodes (named variables + inline <var> tags)
  const availableVariables = useMemo((): AvailableVariable[] => {
    const connectedTextNodes = edges
      .filter((e) => e.target === id && e.targetHandle === "text")
      .map((e) => nodes.find((n) => n.id === e.source))
      .filter((n): n is typeof nodes[0] => n !== undefined);

    const vars: AvailableVariable[] = [];
    const usedNames = new Set<string>();

    // First pass: named variables from Prompt nodes (these take precedence)
    connectedTextNodes.forEach((node) => {
      if (node.type === "prompt") {
        const promptData = node.data as PromptNodeData;
        if (promptData.variableName) {
          vars.push({
            name: promptData.variableName,
            value: promptData.prompt || "",
            nodeId: node.id,
          });
          usedNames.add(promptData.variableName);
        }
      }
    });

    // Second pass: parse inline <var> tags from all connected text nodes
    connectedTextNodes.forEach((node) => {
      let text: string | null = null;
      if (node.type === "prompt") {
        text = (node.data as PromptNodeData).prompt || null;
      } else if (node.type === "llmGenerate") {
        text = (node.data as LLMGenerateNodeData).outputText || null;
      } else if (node.type === "promptConstructor") {
        const pcData = node.data as PromptConstructorNodeData;
        text = pcData.outputText ?? pcData.template ?? null;
      }

      if (text) {
        const parsed = parseVarTags(text);
        parsed.forEach(({ name, value }) => {
          if (!usedNames.has(name)) {
            vars.push({
              name,
              value,
              nodeId: `${node.id}-var-${name}`,
            });
            usedNames.add(name);
          }
        });
      }
    });

    return vars;
  }, [edges, nodes, id]);

  // Autocomplete via shared hook
  const {
    showAutocomplete,
    autocompletePosition,
    filteredAutocompleteVars,
    selectedAutocompleteIndex,
    handleChange,
    handleKeyDown,
    handleAutocompleteSelect,
    closeAutocomplete,
  } = usePromptAutocomplete({
    availableVariables,
    textareaRef,
    localTemplate,
    setLocalTemplate,
    onTemplateCommit: (newTemplate) => updateNodeData(id, { template: newTemplate }),
  });

  // Compute unresolved variables client-side
  const unresolvedVars = useMemo(() => {
    const varPattern = /@(\w+)/g;
    const unresolved: string[] = [];
    const matches = localTemplate.matchAll(varPattern);
    const availableNames = new Set(availableVariables.map(v => v.name));

    for (const match of matches) {
      const varName = match[1];
      if (!availableNames.has(varName) && !unresolved.includes(varName)) {
        unresolved.push(varName);
      }
    }

    return unresolved;
  }, [localTemplate, availableVariables]);

  // Compute resolved text client-side for preview
  const resolvedPreview = useMemo(() => {
    let resolved = localTemplate;
    availableVariables.forEach((v) => {
      resolved = resolved.replace(new RegExp(`@${v.name}`, 'g'), v.value);
    });
    return resolved;
  }, [localTemplate, availableVariables]);

  // Sync resolved text to outputText so downstream nodes can read it before execution
  useEffect(() => {
    let resolved = nodeData.template;
    availableVariables.forEach((v) => {
      resolved = resolved.replace(new RegExp(`@${v.name}`, 'g'), v.value);
    });
    const outputValue = resolved || null;
    if (outputValue !== nodeData.outputText) {
      updateNodeData(id, { outputText: outputValue });
    }
  }, [nodeData.template, availableVariables, id, updateNodeData, nodeData.outputText]);

  const handleFocus = useCallback(() => {
    setIsEditing(true);
  }, []);

  const handleBlur = useCallback(() => {
    setIsEditing(false);
    if (localTemplate !== nodeData.template) {
      updateNodeData(id, { template: localTemplate });
    }
    // Close autocomplete on blur
    setTimeout(() => closeAutocomplete(), 200);
  }, [id, localTemplate, nodeData.template, updateNodeData, closeAutocomplete]);

  const handleOpenModal = useCallback(() => {
    setIsModalOpenLocal(true);
    incrementModalCount();
  }, [incrementModalCount]);

  const handleCloseModal = useCallback(() => {
    setIsModalOpenLocal(false);
    decrementModalCount();
  }, [decrementModalCount]);

  const handleSubmitModal = useCallback(
    (template: string) => {
      updateNodeData(id, { template });
    },
    [id, updateNodeData]
  );

  return (
    <>
      <BaseNode
        id={id}
        title="Prompt Constructor"
        customTitle={nodeData.customTitle}
        comment={nodeData.comment}
        onCustomTitleChange={(title) => updateNodeData(id, { customTitle: title || undefined })}
        onCommentChange={(comment) => updateNodeData(id, { comment: comment || undefined })}
        onExpand={handleOpenModal}
        selected={selected}
        commentNavigation={commentNavigation ?? undefined}
      >
        {/* Text input handle */}
        <Handle
          type="target"
          position={Position.Left}
          id="text"
          data-handletype="text"
        />

        <div className="relative flex flex-col gap-2 flex-1">
          {/* Warning badge for unresolved variables */}
          {unresolvedVars.length > 0 && (
            <div className="px-2 py-1 bg-amber-900/30 border border-amber-700/50 rounded text-[10px] text-amber-400">
              <span className="font-semibold">Unresolved:</span> {unresolvedVars.map(v => `@${v}`).join(', ')}
            </div>
          )}

          {/* Template textarea with autocomplete */}
          <div className="relative flex-1 flex flex-col">
            <textarea
              ref={textareaRef}
              value={localTemplate}
              onChange={handleChange}
              onFocus={handleFocus}
              onBlur={handleBlur}
              onKeyDown={handleKeyDown}
              placeholder="Type @ to insert variables..."
              className="nodrag nopan nowheel w-full flex-1 min-h-[70px] p-2 text-xs leading-relaxed text-neutral-100 border border-neutral-700 rounded bg-neutral-900/50 resize-none focus:outline-none focus:ring-1 focus:ring-neutral-600 focus:border-neutral-600 placeholder:text-neutral-500"
              title={resolvedPreview ? `Preview: ${resolvedPreview}` : undefined}
            />

            {/* Autocomplete dropdown */}
            {showAutocomplete && filteredAutocompleteVars.length > 0 && (
              <div
                className="absolute z-10 bg-neutral-800 border border-neutral-600 rounded shadow-xl max-h-40 overflow-y-auto"
                style={{
                  top: autocompletePosition.top,
                  left: autocompletePosition.left,
                }}
              >
                {filteredAutocompleteVars.map((variable, index) => (
                  <button
                    key={variable.nodeId}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      handleAutocompleteSelect(variable.name);
                    }}
                    className={`w-full px-3 py-2 text-left text-[11px] flex flex-col gap-0.5 transition-colors ${
                      index === selectedAutocompleteIndex
                        ? "bg-neutral-700 text-neutral-100"
                        : "text-neutral-300 hover:bg-neutral-700"
                    }`}
                  >
                    <div className="font-medium text-blue-400">@{variable.name}</div>
                    <div className="text-neutral-500 truncate max-w-[200px]">
                      {variable.value || "(empty)"}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Available variables info */}
          {availableVariables.length > 0 && (
            <div className="text-[10px] text-neutral-500 px-2">
              Available: {availableVariables.map(v => `@${v.name}`).join(', ')}
            </div>
          )}
        </div>

        {/* Text output handle */}
        <Handle
          type="source"
          position={Position.Right}
          id="text"
          data-handletype="text"
        />
      </BaseNode>

      {/* Prompt Constructor Editor Modal - rendered via portal to escape React Flow stacking context */}
      {isModalOpenLocal && createPortal(
        <PromptConstructorEditorModal
          isOpen={isModalOpenLocal}
          initialTemplate={nodeData.template}
          availableVariables={availableVariables}
          onSubmit={handleSubmitModal}
          onClose={handleCloseModal}
        />,
        document.body
      )}
    </>
  );
}
