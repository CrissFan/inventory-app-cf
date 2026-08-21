import { Check } from 'lucide-react';

export default function ReasonSelector({ label, value, onChange, options, tone = 'blue' }) {
  const selectedClasses = tone === 'green'
    ? 'border-green-400 bg-green-50 text-green-800 ring-green-100'
    : 'border-blue-400 bg-blue-50 text-blue-800 ring-blue-100';
  const checkClasses = tone === 'green' ? 'bg-green-500' : 'bg-blue-500';

  return (
    <fieldset>
      <legend className="text-sm font-medium text-gray-700 mb-2">
        {label} <span className="text-red-500">*</span>
      </legend>
      <div className="grid grid-cols-2 gap-2.5">
        {options.map(option => {
          const selected = value === option.value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(option.value)}
              className={`relative min-h-[72px] rounded-xl border p-3 text-left transition-all ${
                selected
                  ? `${selectedClasses} ring-2`
                  : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300 hover:bg-gray-50'
              }`}
            >
              <span className="block pr-6 text-sm font-medium">{option.value}</span>
              <span className={`mt-1 block text-xs leading-4 ${selected ? 'opacity-70' : 'text-gray-400'}`}>
                {option.description}
              </span>
              <span className={`absolute right-2.5 top-2.5 flex h-5 w-5 items-center justify-center rounded-full transition-colors ${
                selected ? `${checkClasses} text-white` : 'border border-gray-300 bg-white'
              }`}>
                {selected && <Check className="h-3 w-3" strokeWidth={3} />}
              </span>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
