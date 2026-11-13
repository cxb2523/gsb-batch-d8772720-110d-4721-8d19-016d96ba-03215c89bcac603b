import React from 'react';
import ReactDiffViewer from 'react-diff-viewer-continued';
import { FileCode, Copy, Check } from 'lucide-react';

const DiffViewer = ({ oldCode, newCode, fileName, splitView = true }) => {
    const [copied, setCopied] = React.useState(false);

    const handleCopy = () => {
        navigator.clipboard.writeText(newCode);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const customStyles = {
        variables: {
            light: {
                diffViewerBackground: '#ffffff',
                diffViewerColor: '#374151',
                addedBackground: '#ecfdf5',
                addedColor: '#047857',
                removedBackground: '#fef2f2',
                removedColor: '#b91c1c',
                wordAddedBackground: '#d1fae5',
                wordRemovedBackground: '#fee2e2',
                addedGutterBackground: '#ecfdf5',
                removedGutterBackground: '#fef2f2',
                gutterBackground: '#f9fafb',
                gutterColor: '#9ca3af',
                emptyLineBackground: '#ffffff',
                lineNumberColor: '#9ca3af',
                diffViewerTitleBackground: '#f3f4f6',
                diffViewerTitleColor: '#4b5563',
                diffViewerTitleBorderColor: '#e5e7eb',
            }
        },
        header: {
            background: '#f3f4f6',
            padding: '10px 15px',
            borderBottom: '1px solid #e5e7eb',
        }
    };

    return (
        <div className="rounded-xl overflow-hidden border border-gray-300 bg-white shadow-md">
            <div className="flex items-center justify-between p-3 bg-gray-50 border-b border-gray-300">
                <div className="flex items-center gap-2">
                    <FileCode size={16} className="text-indigo-600" />
                    <span className="text-xs font-mono text-gray-900">{fileName || 'code_patch.diff'}</span>
                </div>
                <button
                    onClick={handleCopy}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-gray-100 hover:bg-gray-200 transition-all text-[10px] font-bold text-gray-900"
                >
                    {copied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
                    {copied ? 'COPIED!' : 'COPY NEW CODE'}
                </button>
            </div>
            <div className="text-[12px] font-mono">
                <ReactDiffViewer
                     oldValue={oldCode}
                     newValue={newCode}
                     splitView={splitView}
                     useDarkTheme={false}
                     styles={customStyles}
                     leftTitle="Original"
                     rightTitle="Modified"
                />
            </div>
        </div>
    );
};

export default DiffViewer;
