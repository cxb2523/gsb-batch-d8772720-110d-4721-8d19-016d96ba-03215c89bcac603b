import logging
from dataclasses import dataclass
from pathlib import Path

import pandas as pd
from typing import Optional

logger = logging.getLogger(__name__)


class AllChunksFailedError(RuntimeError):
    """Raised when every chunk read from a CSV fails to convert to tidy format.

    The per-chunk outcome report is attached as the ``chunk_report`` attribute
    so that the failure reason of every chunk remains inspectable.
    """

    def __init__(self, message: str, chunk_report: pd.DataFrame):
        super().__init__(message)
        self.chunk_report = chunk_report


@dataclass
class TidyReadResult:
    """Result of :func:`read_csv_to_tidy`.

    :ivar tidy: Tidy-format DataFrame built by vertically concatenating the
        successful chunks.
    :ivar chunk_report: DataFrame with one row per read chunk and the columns
        ``chunk`` (1-based chunk index), ``input_rows`` (rows read from the
        CSV for that chunk), ``output_rows`` (rows produced by the conversion,
        NaN when the chunk failed), ``success`` (whether the conversion
        succeeded) and ``error`` (failure reason or ``None``).
    """

    tidy: pd.DataFrame
    chunk_report: pd.DataFrame


def _validate_chunked_csv_arguments(
        filepath, data_type: str, chunksize: int) -> Path:
    """Validates the arguments of :func:`read_csv_to_tidy` and the CSV header.

    :return: The resolved :class:`~pathlib.Path` of the CSV file.
    :raises ValueError: If ``chunksize`` or ``data_type`` is invalid or a
        required column is missing.
    :raises FileNotFoundError: If ``filepath`` does not point to an existing
        file.
    """
    if isinstance(chunksize, bool) or not isinstance(chunksize, int):
        raise ValueError(
            f"chunksize must be a positive integer >= 1; got {chunksize!r}.")
    if chunksize < 1:
        raise ValueError(
            f"chunksize must be a positive integer >= 1; got {chunksize!r}.")

    if data_type not in ("long", "static"):
        raise ValueError(
            f"data_type must be 'long' or 'static'; got {data_type!r}.")

    path = Path(filepath)
    if not path.is_file():
        raise FileNotFoundError(f"CSV file not found: {path}")

    header = pd.read_csv(path, nrows=0)
    if "PTNO" not in header.columns:
        raise ValueError(
            f"Column 'PTNO' is required but was not found in {path}. "
            f"Available columns: {list(header.columns)}")
    if data_type == "long" and "TIME" not in header.columns:
        raise ValueError(
            f"Column 'TIME' is required for data_type='long' but was not "
            f"found in {path}. Available columns: {list(header.columns)}")
    return path


def _convert_chunk(chunk: pd.DataFrame, data_type: str,
                   only_pos: bool, only_realtimes: bool) -> pd.DataFrame:
    """Converts one CSV chunk to tidy format."""
    return convert_data_to_tidy(
        chunk,
        data_type,
        only_pos=only_pos,
        only_realtimes=only_realtimes)


def read_csv_to_tidy(
        filepath,
        data_type: str,
        chunksize: int = 100_000,
        only_pos: bool = False,
        only_realtimes: bool = False) -> TidyReadResult:
    """
    Reads a wide-format CSV in row-wise chunks and converts each chunk to tidy
    format with :func:`convert_data_to_tidy`.

    The chunks are read independently and the successful tidy frames are
    concatenated vertically, so the result is equivalent to reading the whole
    file at once and converting it, regardless of the chosen ``chunksize``.
    A failing chunk is recorded in the chunk report and does not interrupt the
    reading of the remaining chunks; if every chunk fails, an
    :class:`AllChunksFailedError` is raised.

    :param filepath: Path to the wide-format CSV file.
    :param data_type: Type of data to convert; ``'long'`` for longitudinal
        data (requires a ``TIME`` column) or ``'static'`` for static data.
    :param chunksize: Number of CSV rows read per chunk. Must be a positive
        integer (``>= 1``).
    :param only_pos: Passed through to :func:`convert_data_to_tidy`; if True,
        clips negative values to zero.
    :param only_realtimes: Passed through to :func:`convert_data_to_tidy`; if
        True, keeps only observations whose mask is 1.
    :return: A :class:`TidyReadResult` holding the concatenated tidy
        DataFrame and a per-chunk outcome report.
    :raises ValueError: If ``chunksize`` is not a positive integer,
        ``data_type`` is neither ``'long'`` nor ``'static'``, a required
        column (``PTNO``, or ``TIME`` for longitudinal data) is missing, or
        the file contains no data rows.
    :raises FileNotFoundError: If ``filepath`` does not point to an existing
        file.
    :raises AllChunksFailedError: If every read chunk fails to convert.
    """
    path = _validate_chunked_csv_arguments(filepath, data_type, chunksize)

    tidy_chunks = []
    report_rows = []
    total_input_rows = 0
    reader = pd.read_csv(path, chunksize=chunksize)
    for chunk_index, chunk in enumerate(reader, start=1):
        input_rows = len(chunk)
        total_input_rows += input_rows
        try:
            tidy_chunk = _convert_chunk(
                chunk, data_type, only_pos, only_realtimes)
        except Exception as exc:
            # Record the failure and continue with the remaining chunks.
            reason = f"{type(exc).__name__}: {exc}"
            logger.warning("Chunk %s failed to convert to tidy format: %s",
                           chunk_index, reason)
            report_rows.append({
                "chunk": chunk_index,
                "input_rows": input_rows,
                "output_rows": None,
                "success": False,
                "error": reason})
            continue

        report_rows.append({
            "chunk": chunk_index,
            "input_rows": input_rows,
            "output_rows": len(tidy_chunk),
            "success": True,
            "error": None})
        tidy_chunks.append(tidy_chunk)

    chunk_report = pd.DataFrame(
        report_rows,
        columns=["chunk", "input_rows", "output_rows", "success", "error"])

    if total_input_rows == 0:
        raise ValueError(f"No data rows found in CSV file: {path}")

    if not chunk_report["success"].any():
        raise AllChunksFailedError(
            f"All {len(chunk_report)} chunk(s) failed while converting "
            f"{path} to tidy format; inspect the chunk report for the "
            f"failure reasons.",
            chunk_report)

    tidy = pd.concat(tidy_chunks, ignore_index=True)
    return TidyReadResult(tidy=tidy, chunk_report=chunk_report)


def merge_real_synthetic(
        real_df: pd.DataFrame,
        synthetic_df: pd.DataFrame,
        patient_identifier: str = 'PTNO',
        type='static') -> pd.DataFrame:
    """
    Merges a real and a synthetic dataframe with the same variable name,
    into one dataframe, renames columns and create others for library
    compatibility

    param real_df: real dataframe with at least one column to identify patient ID and time if type=='longitudinal'
    param synthetic_df: real dataframe with at least one column to identify patient ID and time if type=='longitudinal'
    param patient_identifier: column name to identify different patients
    param type: defines whether the data is longitudinal or static
    return: combined dataframe with real and synthetic data including required columns for compatibility.
    """
    if type not in ["static", "longitudinal"]:
        logger.info(f"Invalid type '{type}'. Allowed values are 'static' or 'longitudinal'.")
        raise AssertionError("Invalid value for `type`.")

    for name, df in zip(['real_df', 'synthetic_df'], [real_df, synthetic_df]):
        if type == 'longitudinal':
            if 'TIME' not in df.columns:
                logger.info(f"'TIME' column is required for longitudinal data in {name}.")
                raise AssertionError("TIME column is required")
        elif type == 'static':
            if 'TIME' in df.columns:
                logger.info(f"'TIME' column is NOT supported for static data in {name}.")
                raise AssertionError("TIME column is not supported")
        if "DRUG" not in df.columns:
            logger.info(f"Column 'DRUG' not found in {name} — adding it with zeros for library compatibility.")
            df["DRUG"] = 0
        if "REPI" not in df.columns:
            logger.info(f"Column 'REPI' not found in {name} — adding it with ones for library compatibility.")
            df["REPI"] = 1

    real_df = real_df.rename(columns={patient_identifier: 'PTNO'})
    synthetic_df = synthetic_df.rename(columns={patient_identifier: 'PTNO'})

    if type == 'longitudinal':
        exclude_cols = {'PTNO', 'DRUG', 'REPI', 'TIME'}
    elif type == 'static':
        exclude_cols = {'PTNO', 'DRUG', 'REPI'}

    real_mask_cols = [col for col in real_df.columns if col.startswith('MASK')]
    synthetic_mask_cols = [col for col in synthetic_df.columns if col.startswith('MASK')]

    real_vars = [col for col in real_df.columns if col not in exclude_cols and not col.startswith('MASK')]
    synthetic_vars = [col for col in synthetic_df.columns if col not in exclude_cols and not col.startswith('MASK')]

    if not real_mask_cols and not synthetic_mask_cols:
        for col in real_vars:
            logger.info(
                f"Column 'MASK_{col}' not found. Assuming all time points in the real dataframe are observed. Adding column with ones.")
            real_df[f'MASK_{col}'] = 1

    real_rename = {col: f"OBS_{col}" for col in real_vars}
    synthetic_rename = {col: f"REC_{col}" for col in synthetic_vars}
    real_df = real_df.rename(columns=real_rename)
    synthetic_df = synthetic_df.rename(columns=synthetic_rename)

    synthetic_df = synthetic_df.drop(columns=[c for c in synthetic_mask_cols if c in synthetic_df.columns])
    merged_df = pd.merge(real_df, synthetic_df, on=list(exclude_cols), how="inner")

    return merged_df

def convert_to_syndat_scores(
    df: pd.DataFrame,
    only_pos: bool = False) -> tuple[pd.DataFrame, pd.DataFrame]:
    """
    Converts a DataFrame containing observed and predicted (``REC_``) columns into two separate DataFrames,
    synchronizing values based on MASK columns and optionally clipping predicted values to be non-negative.

    :param df: DataFrame containing columns with prefixes ``OBS_``, ``REC_``, ``MASK_`` and a ``REPI`` column.
    :param only_pos: If True, clips negative values in ``REC_`` columns to zero.
    :return: Tuple of two DataFrames: (observed_df, predicted_df) with synchronized and filtered values.
    """
    if "REPI" not in df.columns:
        logger.info("Column 'REPI' not found — adding it with ones for library compatibility.")
        df["REPI"] = 1

    df = df[df.REPI == 1]
    for col in df.columns:
        if only_pos and col.startswith("REC_"):
            df[col] = df[col].clip(lower=0)
        if col.startswith("MASK"):
            var_name = "_".join(col.split("_")[1:])
            mask = df[col] == 0
            # Setting values to NAN where  mask is 0
            df[f'OBS_{var_name}'] = df[f'OBS_{var_name}'].mask(mask)
            df[f'REC_{var_name}'] = df[f'REC_{var_name}'].mask(mask)

    observed_df = df[[col for col in df.columns if col.startswith("OBS")]]
    predictions_df = df[[col for col in df.columns if col.startswith("REC")]]
    predictions_df.columns = observed_df.columns
    return observed_df, predictions_df

def get_rp(
    ldt: Optional[pd.DataFrame] = None,
    lt: Optional[pd.DataFrame] = None,
    st: Optional[pd.DataFrame] = None,
    Tmax: Optional[int] = None) -> dict:
    """
    Creates a dictionary with static and longitudinal variable names categorized by type (categorical, continuous),
    and computes the maximum time value.

    :param ldt: Longitudinal DataFrame containing at 'TIME' column.
    :param lt: Longitudinal variables metadata DataFrame with columns 'Variable', 'Type', and 'Cats'.
    :param st: Static variables metadata DataFrame with columns 'Variable' and 'Type'.
    :param Tmax: Optional maximum time value (required if lt is provided but ldt is not).
    :return: Dictionary with keys: 'Tmax', 'static_vnames', 'static_cat', 'static_cont',
             'long_vnames', 'long_cat', 'long_bin', 'long_cont', each mapping to lists of variable names.
    """

    if lt is None and st is None:
        raise AssertionError("At least one of 'lt' or 'st' must be provided.")

    if lt is not None and ldt is None and Tmax is None:
        raise AssertionError("If 'lt' is provided, you must also provide either 'ldt' or 'Tmax'.")

    rp = {}
    if ldt is not None:
        if "TIME" not in ldt.columns:
            raise AssertionError("'ldt' must contain a 'TIME' column.")
        rp["Tmax"] = ldt.TIME.max()
    else:
        rp["Tmax"] = Tmax

    if st is not None:
        rp["static_vnames"] = st["Variable"].dropna().unique().tolist()
        rp["static_cat"] = st[st["Type"] == "cat"]["Variable"].dropna().unique().tolist()
        rp["static_bin"] = st[(st["Type"] == "cat") & (st["Cats"] == 2)]["Variable"].dropna().unique().tolist()
        rp["static_cont"] = st[st["Type"] != "cat"]["Variable"].dropna().unique().tolist()
    else:
        rp["static_vnames"] = []
        rp["static_cat"] = []
        rp["static_bin"] = []
        rp["static_cont"] = []

    if lt is not None:
        rp["long_vnames"] = lt["Variable"].dropna().unique().tolist()
        rp["long_cat"] = lt[lt["Type"] == "cat"]["Variable"].dropna().unique().tolist()
        rp["long_bin"] = lt[(lt["Type"] == "cat") & (lt["Cats"] == 2)]["Variable"].dropna().unique().tolist()
        rp["long_cont"] = lt[lt["Type"] != "cat"]["Variable"].dropna().unique().tolist()
    else:
        rp["long_vnames"] = []
        rp["long_cat"] = []
        rp["long_bin"] = []
        rp["long_cont"] = []
    return rp

def convert_long_data_to_tidy(df0: pd.DataFrame, only_pos: bool = False) -> pd.DataFrame:
    """
    Converts a wide-format DataFrame to a tidy-format DataFrame by encoding variables into separate columns,
    separates variable types and names, applies masking, and optionally clips negative values.

    :param df0: Original wide-format DataFrame with encoded columns (e.g., 'OBS_var', 'REC_var', 'MASK_var').
    :param only_pos: If True, clips negative values in the 'DV' column to zero.
    :return: A tidy-format DataFrame with columns: 'SUBJID', 'REPI', 'TIME', 'DRUG', 'TYPE', 'Variable', 'DV', and 'MASK'.
    """

    if "DRUG" not in df0.columns:
        logger.info("Column 'DRUG' not found — adding it with zeros for library compatibility.")
        df0["DRUG"] = 0

    df1 = df0.melt(id_vars=["PTNO", "REPI", "TIME", "DRUG"], 
                   var_name="FullVar", value_name="DV")
    df1[['TYPE', 'Variable']] = df1['FullVar'].str.extract(r'([^_]+)_(.*)')
    df1.drop(columns='FullVar', inplace=True)
    df1["TIME2"] = (df1["TIME"] * 1_000_000).round().astype(int)
    if only_pos:
        df1["DV"] = df1["DV"].clip(lower=0)
    df_main = df1[df1["TYPE"] != "MASK"].copy()
    df_mask = df1[df1["TYPE"] == "MASK"].copy()

    df_mask = df_mask.drop(columns=["TIME", "TYPE", "DRUG"]).rename(columns={"DV": "MASK"})
    df_final = df_main.merge(df_mask, on=["PTNO", "REPI", "Variable", "TIME2"], how="left")
    df_final["TIME"] = df_final["TIME"].round(2)
    df_final.drop(columns="TIME2", inplace=True)
    df_final.rename(columns={"PTNO": "SUBJID"}, inplace=True)
    return df_final

def convert_static_data_to_tidy(df0: pd.DataFrame, only_pos: bool = False) -> pd.DataFrame:
    """
    Converts a wide-format static DataFrame to a tidy-format DataFrame.
    It melts the dataframe, separates variable types and names, applies masking,
    and optionally clips negative values.

    :param df0: Input wide-format DataFrame containing static data with columns including 'PTNO' and 'REPI'.
    :param only_pos: If True, clips negative values in the data to zero.
    :return: A tidy-format DataFrame with columns ['SUBJID', 'REPI', 'TYPE', 'Variable', 'DV', 'MASK'].
    """

    id_vars = ["PTNO", "REPI"]
    cols_ = ["TYPE"]
    if "DRUG" in df0.columns:
        id_vars = id_vars + ["DRUG"]
        cols_ = cols_ + ["DRUG"]
    df1 = df0.melt(id_vars=id_vars, 
                   var_name="FullVar", 
                   value_name="DV")
    df1[["TYPE", "Variable"]] = df1["FullVar"].str.extract(r'([^_]+)_(.*)')
    df1.drop(columns='FullVar', inplace=True)
    if only_pos:
        df1["DV"] = df1["DV"].clip(lower=0)
    df_mask = df1[df1["TYPE"] == "MASK"].drop(columns=cols_).rename(columns={"DV": "MASK"})
    df_final = df1[df1["TYPE"] != "MASK"].merge(df_mask, on=["PTNO", "REPI", "Variable"], how="left")
    df_final = df_final.rename(columns={"PTNO": "SUBJID"})
    return df_final

def convert_data_to_tidy(df0: pd.DataFrame, type: str, only_pos: bool = False, only_realtimes: bool = False) -> pd.DataFrame:
    """
    Converts a DataFrame from wide to tidy format, depending on whether it is longitudinal or static data.
    It uses `convert_long_data` for longitudinal data and `convert_static_data` for static data.
    It filters the observations to keep only observed values where the mask is 1, and renames type categories.

    :param df0: Input wide-format DataFrame.
    :param type: Type of data to convert; 'long' for longitudinal or other values for static data.
    :param only_pos: If True, clips negative values in the data to zero.
    :return: A tidy-format DataFrame with standardized TYPE column ('Observed', 'Reconstructed', 'Simulations').
    """
    if "REPI" not in df0.columns:
        logger.info("Column 'REPI' not found — adding it with ones for library compatibility.")
        df0["REPI"] = 1

    if type=='long':
        df_final = convert_long_data_to_tidy(df0,only_pos=only_pos)
    else:
        df_final = convert_static_data_to_tidy(df0,only_pos=only_pos)

    if only_realtimes:
        df_final = df_final[df_final["MASK"] == 1]
    else:
        df_final = df_final[
            ((df_final["TYPE"] == "OBS") & (df_final["MASK"] == 1)) | (df_final["TYPE"] != "OBS")]

    df_final = df_final.drop(columns=["MASK"])

    df_final["TYPE"] = df_final["TYPE"].replace({
        "OBS": "Observed",
        "REC": "Reconstructed",
        "SIM": "Simulations"})
    return df_final