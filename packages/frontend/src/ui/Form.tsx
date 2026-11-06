/**
 * A small form model: a form instance holding values, Form.Item binding a
 * named control to it (value/checked + onChange), required-field checks on
 * submit, and useWatch for dependent fields. Enough for the settings and
 * launch drawers; no schema validation beyond "required".
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { cx } from "./basics";

type Values = Record<string, any>;

interface Store {
  values: Values;
  listeners: Set<() => void>;
  required: Set<string>;
  errors: Record<string, string>;
  submit: () => void;
}

export interface FormInstance {
  getFieldsValue: () => Values;
  getFieldValue: (name: string) => any;
  setFieldsValue: (patch: Values) => void;
  setFieldValue: (name: string, value: any) => void;
  resetFields: () => void;
  submit: () => void;
  /** @internal */
  __store: Store;
}

function createInstance(): FormInstance {
  const store: Store = { values: {}, listeners: new Set(), required: new Set(), errors: {}, submit: () => {} };
  const notify = () => store.listeners.forEach((l) => l());
  return {
    __store: store,
    getFieldsValue: () => ({ ...store.values }),
    getFieldValue: (name) => store.values[name],
    setFieldsValue: (patch) => { store.values = { ...store.values, ...patch }; notify(); },
    setFieldValue: (name, value) => { store.values = { ...store.values, [name]: value }; if (store.errors[name]) { const { [name]: _, ...rest } = store.errors; store.errors = rest; } notify(); },
    resetFields: () => { store.values = {}; store.errors = {}; notify(); },
    submit: () => store.submit(),
  };
}

export function useForm(): [FormInstance] {
  const ref = useRef<FormInstance | null>(null);
  if (!ref.current) ref.current = createInstance();
  return [ref.current];
}

function useStoreVersion(form: FormInstance | null) {
  const [, force] = useState(0);
  useEffect(() => {
    if (!form) return undefined;
    const l = () => force((n) => n + 1);
    form.__store.listeners.add(l);
    return () => { form.__store.listeners.delete(l); };
  }, [form]);
}

export function useWatch(name: string, form: FormInstance): any {
  useStoreVersion(form);
  return form.__store.values[name];
}

const FormContext = createContext<{ form: FormInstance; size?: string } | null>(null);

export interface FormProps {
  form?: FormInstance;
  layout?: "vertical" | "horizontal" | "inline";
  size?: "small" | "middle" | "large";
  initialValues?: Values;
  onFinish?: (values: Values) => void | Promise<void>;
  children?: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
}

const FormBase: React.FC<FormProps> = ({ form: given, initialValues, onFinish, children, style, className, size }) => {
  const [own] = useForm();
  const form = given || own;
  useStoreVersion(form);
  useEffect(() => {
    if (initialValues) {
      const missing: Values = {};
      for (const [k, v] of Object.entries(initialValues)) if (form.__store.values[k] === undefined) missing[k] = v;
      if (Object.keys(missing).length) form.setFieldsValue(missing);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const submit = useCallback(() => {
    const store = form.__store;
    const errors: Record<string, string> = {};
    store.required.forEach((name) => {
      const v = store.values[name];
      if (v === undefined || v === null || v === "" || v === false) errors[name] = "Required";
    });
    store.errors = errors;
    store.listeners.forEach((l) => l());
    if (Object.keys(errors).length === 0) void onFinish?.({ ...store.values });
  }, [form, onFinish]);
  form.__store.submit = submit;
  const ctx = useMemo(() => ({ form, size }), [form, size]);
  return (
    <FormContext.Provider value={ctx}>
      <form className={className} style={style} onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
        {children}
      </form>
    </FormContext.Provider>
  );
};

export interface FormItemProps {
  name?: string;
  label?: React.ReactNode;
  rules?: Array<{ required?: boolean; message?: string }>;
  valuePropName?: "value" | "checked";
  initialValue?: any;
  extra?: React.ReactNode;
  help?: React.ReactNode;
  children?: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
}

const FormItem: React.FC<FormItemProps> = ({ name, label, rules, valuePropName = "value", initialValue, extra, help, children, style, className }) => {
  const ctx = useContext(FormContext);
  const form = ctx?.form || null;
  useStoreVersion(form);
  const required = Boolean(rules?.some((r) => r.required));
  useEffect(() => {
    if (!form || !name) return undefined;
    if (required) form.__store.required.add(name);
    if (initialValue !== undefined && form.__store.values[name] === undefined) form.setFieldValue(name, initialValue);
    return () => { form.__store.required.delete(name); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, name, required]);

  let control = children;
  if (form && name && React.isValidElement(children)) {
    const value = form.__store.values[name];
    control = React.cloneElement(children as React.ReactElement<any>, {
      [valuePropName]: valuePropName === "checked" ? Boolean(value) : value ?? "",
      onChange: (arg: any) => {
        const next = arg && typeof arg === "object" && "target" in arg
          ? (valuePropName === "checked" ? arg.target.checked : arg.target.value)
          : arg;
        form.setFieldValue(name, next);
        (children as React.ReactElement<any>).props.onChange?.(arg);
      },
    });
  }
  const error = form && name ? form.__store.errors[name] : undefined;
  return (
    <div className={cx("tui-form-item", className)} style={style}>
      {label != null && <label className={cx("tui-form-label", required && "tui-form-required")}>{label}</label>}
      {control}
      {error ? <div className="tui-form-error">{error}</div> : null}
      {help ? <div className="tui-form-extra">{help}</div> : null}
      {extra ? <div className="tui-form-extra">{extra}</div> : null}
    </div>
  );
};

export const Form = Object.assign(FormBase, { Item: FormItem, useForm, useWatch });
